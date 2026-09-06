import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createRateLimiter,
  createServer,
  JsonStore,
  recoverReviewJobs,
  reserveReview,
  spawnReviewer,
  verifyWebhookSignature,
} from './server.mjs';

function webhookSignature(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

test('validates GitHub webhook signatures against raw bytes', () => {
  const secret = "It's a Secret to Everybody";
  const body = Buffer.from('Hello, World!');
  const signature = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
  assert.equal(verifyWebhookSignature(secret, body, signature), true);
  assert.equal(verifyWebhookSignature(secret, Buffer.from('changed'), signature), false);
  assert.equal(verifyWebhookSignature(secret, body, 'sha256=short'), false);
});

test('rate limiter isolates installations and resets its window', () => {
  let now = 0;
  const limiter = createRateLimiter(2, () => now);
  assert.equal(limiter.accept('1'), true);
  assert.equal(limiter.accept('1'), true);
  assert.equal(limiter.accept('1'), false);
  assert.equal(limiter.accept('2'), true);
  now = 60_000;
  assert.equal(limiter.accept('1'), true);
});

test('reservation enforces enablement, idempotency, and monthly quota', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'second-opinion-hosted-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'state.json'));
  await store.init();
  const job = {
    installationId: 4,
    repositoryId: 9,
    repository: 'owner/repo',
    pullNumber: 2,
    headSha: 'abc',
  };

  assert.deepEqual(await reserveReview(store, job, 1, 10), {
    accepted: false,
    reason: 'installation_disabled',
  });
  await store.update((state) => {
    state.installations['4'] = {
      id: '4', enabled: true, provider: 'openai', model: 'test', plan: 'free',
    };
  });
  assert.equal((await reserveReview(store, job, 1, 10)).accepted, true);
  assert.deepEqual(await reserveReview(store, job, 1, 10), {
    accepted: false,
    reason: 'duplicate',
  });
  assert.deepEqual(await reserveReview(store, { ...job, headSha: 'def' }, 1, 10), {
    accepted: false,
    reason: 'quota_exceeded',
  });
});

test('recovers interrupted reviews as queued work', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'second-opinion-hosted-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'state.json'));
  await store.init();
  const createdAt = Date.now();
  await store.update((state) => {
    state.jobs.running = {
      status: 'running', job: { installationId: 1 }, createdAt, updatedAt: createdAt,
    };
    state.jobs.queued = {
      status: 'queued', job: { installationId: 2 }, createdAt, updatedAt: createdAt,
    };
    state.jobs.succeeded = {
      status: 'succeeded', job: { installationId: 3 }, createdAt, updatedAt: createdAt,
    };
  });

  const recovered = await recoverReviewJobs(store, createdAt + 1);

  assert.deepEqual(recovered.map(({ jobKey }) => jobKey).sort(), ['queued', 'running']);
  assert.deepEqual(await store.read((state) => state.jobs.running), {
    status: 'queued', job: { installationId: 1 }, createdAt, updatedAt: createdAt + 1,
  });
  assert.equal(await store.read((state) => state.jobs.succeeded.status), 'succeeded');
});

test('reviewer timeout escalates to SIGKILL', { timeout: 2_000 }, async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'second-opinion-hosted-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const reviewer = path.join(directory, 'reviewer');
  await fs.writeFile(reviewer, [
    '#!/usr/bin/env node',
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1_000);',
    '',
  ].join('\n'), { mode: 0o700 });
  const controller = new AbortController();

  await assert.rejects(spawnReviewer(
    {
      reviewerBinary: reviewer,
      reviewTimeoutMs: 250,
      reviewerKillGraceMs: 50,
      botLogin: 'test[bot]',
    },
    { provider: 'openai', model: 'test-model' },
    'github-token',
    { repository: 'owner/repo', pullNumber: 1, headSha: 'abc' },
    controller.signal,
  ), /reviewer timed out after 250ms/);
});

test('signed webhooks manage installation lifecycle and reject work at capacity', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'second-opinion-hosted-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'state.json'));
  await store.init();
  const config = {
    publicUrl: 'http://127.0.0.1',
    webhookSecret: 'webhook-test-secret',
    workerConcurrency: 1,
    maxPendingReviews: 1,
    rateLimitPerMinute: 2,
    monthlyReviewLimit: 3,
    models: { openai: ['test-model'] },
  };
  const server = await createServer(config, store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const body = JSON.stringify({
    action: 'created',
    installation: { id: 12, account: { login: 'example' } },
    sender: { id: 34 },
  });
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/github/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'installation',
      'x-hub-signature-256': webhookSignature(config.webhookSecret, body),
    },
    body,
  });

  assert.equal(response.status, 202);
  const installation = await store.read((state) => state.installations['12']);
  assert.equal(installation.managerId, 34);
  assert.equal(installation.enabled, false);

  await store.update((state) => {
    state.jobs['12:9:2:abc'] = {
      status: 'queued', createdAt: Date.now(), updatedAt: Date.now(),
    };
  });
  const suspended = JSON.stringify({
    action: 'suspend',
    installation: { id: 12, account: { login: 'example' } },
    sender: { id: 34 },
  });
  await fetch(`http://127.0.0.1:${address.port}/github/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'installation',
      'x-hub-signature-256': webhookSignature(config.webhookSecret, suspended),
    },
    body: suspended,
  });
  assert.equal(await store.read((state) => state.installations['12'].suspended), true);
  assert.equal(await store.read((state) => state.installations['12'].managerId), 34);
  assert.equal(await store.read((state) => state.jobs['12:9:2:abc'].status), 'cancelled');

  await store.update((state) => {
    state.sessions.session = { user: { id: 34 }, expiresAt: Date.now() + 60_000 };
  });
  const revoked = JSON.stringify({ action: 'revoked', sender: { id: 34 } });
  const revokedResponse = await fetch(`http://127.0.0.1:${address.port}/github/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'github_app_authorization',
      'x-hub-signature-256': webhookSignature(config.webhookSecret, revoked),
    },
    body: revoked,
  });
  assert.equal(revokedResponse.status, 202);
  assert.equal(await store.read((state) => Object.keys(state.sessions).length), 0);

  await store.update((state) => {
    state.installations['12'].enabled = true;
    state.installations['12'].suspended = false;
    state.jobs.pending = {
      status: 'queued', job: { installationId: 99 }, createdAt: Date.now(), updatedAt: Date.now(),
    };
  });
  const pullRequest = JSON.stringify({
    action: 'opened',
    installation: { id: 12 },
    repository: { id: 9, full_name: 'owner/repo' },
    pull_request: { number: 3, draft: false, head: { sha: 'def' } },
  });
  const busyResponse = await fetch(`http://127.0.0.1:${address.port}/github/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': webhookSignature(config.webhookSecret, pullRequest),
    },
    body: pullRequest,
  });
  assert.equal(busyResponse.status, 503);
  assert.equal(busyResponse.headers.get('retry-after'), '30');
  assert.deepEqual(await busyResponse.json(), { accepted: false, reason: 'service_busy' });
});
