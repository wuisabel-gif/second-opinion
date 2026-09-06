import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createQueue,
  createRateLimiter,
  createServer,
  JsonStore,
  loadConfig,
  reviewerEnvironment,
  reserveReview,
  spawnReviewer,
  verifyWebhookSignature,
} from './server.mjs';

function webhookSignature(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function hostedEnv(overrides = {}) {
  return {
    PUBLIC_URL: 'https://second-opinion.example',
    SESSION_SECRET: 's'.repeat(32),
    GITHUB_WEBHOOK_SECRET: 'w'.repeat(32),
    GITHUB_APP_ID: '123',
    GITHUB_APP_SLUG: 'second-opinion',
    GITHUB_CLIENT_ID: 'client',
    GITHUB_CLIENT_SECRET: 'secret',
    GITHUB_PRIVATE_KEY: 'private-key-for-config-test',
    GITHUB_BOT_LOGIN: 'second-opinion[bot]',
    OPENAI_API_KEY: 'api-key',
    ...overrides,
  };
}

test('hosted config validates origins and supports a Codex-only provider', () => {
  assert.throws(
    () => loadConfig(hostedEnv({ PUBLIC_URL: 'https://example.com/path' })),
    /must be an origin/,
  );
  assert.throws(
    () => loadConfig(hostedEnv({ GITHUB_WEBHOOK_SECRET: 'short' })),
    /at least 32 bytes/,
  );
  assert.throws(
    () => loadConfig(hostedEnv({ GITHUB_APP_ID: 'not-numeric' })),
    /must be numeric/,
  );
  assert.throws(
    () => loadConfig(hostedEnv({ CODEX_BROKER_URL: 'https://broker.example' })),
    /configured together/,
  );
  const config = loadConfig(hostedEnv({
    OPENAI_API_KEY: undefined,
    CODEX_BROKER_URL: 'https://broker.example',
    CODEX_BROKER_TOKEN: 't'.repeat(32),
  }));
  assert.deepEqual(config.models, { 'codex-broker': ['gpt-5.6-sol'] });
});

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

test('bounded worker queue rejects excess pending work', async () => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const completed = [];
  const enqueue = createQueue(1, 1, async (value) => {
    await blocker;
    completed.push(value);
  });
  assert.equal(enqueue('active'), true);
  assert.equal(enqueue('queued'), true);
  assert.equal(enqueue('rejected'), false);
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(completed, ['active', 'queued']);
});

test('closing a worker queue drops pending work and drains the active worker', async () => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const completed = [];
  const enqueue = createQueue(1, 2, async (value) => {
    await blocker;
    completed.push(value);
  });
  assert.equal(enqueue('active'), true);
  assert.equal(enqueue('pending'), true);
  assert.deepEqual(enqueue.close(), ['pending']);
  assert.equal(enqueue('after-close'), false);
  let drained = false;
  const waiting = enqueue.waitForIdle().then(() => { drained = true; });
  assert.equal(drained, false);
  release();
  await waiting;
  assert.deepEqual(completed, ['active']);
});

test('restart recovery requeues interrupted running jobs', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'second-opinion-hosted-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const statePath = path.join(directory, 'state.json');
  await fs.writeFile(statePath, JSON.stringify({
    installations: {}, usage: {}, sessions: {},
    jobs: {
      interrupted: {
        status: 'running',
        job: { installationId: 1 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  }));
  const store = new JsonStore(statePath);
  await store.init();
  assert.equal(await store.read((state) => state.jobs.interrupted.status), 'queued');
  const persisted = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(persisted.jobs.interrupted.status, 'queued');
});

test('Codex hosted provider sends only the internal broker credential', () => {
  const config = {
    codexBrokerUrl: 'https://broker.example',
    codexBrokerToken: 't'.repeat(32),
    botLogin: 'second-opinion[bot]',
  };
  const environment = reviewerEnvironment(
    config,
    { provider: 'codex-broker', model: 'gpt-5.6-sol' },
    'github-installation-token',
    { repository: 'owner/repo', pullNumber: 3, headSha: 'abc' },
  );
  assert.equal(environment.REVIEW_PROVIDER, 'webhook');
  assert.equal(environment.REVIEW_ENDPOINT, 'https://broker.example/v1/internal/reviews');
  assert.equal(environment.REVIEW_API_KEY, 't'.repeat(32));
  assert.equal(environment.GITHUB_TOKEN, 'github-installation-token');
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.CODEX_AUTH_JSON, undefined);
});

test('reviewer timeout terminates a child that ignores SIGTERM', async (context) => {
  if (process.platform === 'win32') return;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'second-opinion-hosted-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'reviewer.sh');
  await fs.writeFile(executable, '#!/bin/sh\ntrap "" TERM\nsleep 30\n', { mode: 0o700 });
  const controller = new AbortController();
  await assert.rejects(
    spawnReviewer(
      { reviewerBinary: executable, reviewTimeoutMs: 20, botLogin: 'bot' },
      { provider: 'openai', model: 'test' },
      'github-token',
      { repository: 'owner/repo', pullNumber: 1, headSha: 'abc' },
      controller.signal,
    ),
    /timed out/,
  );
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

  assert.deepEqual(await reserveReview(store, job, 1), {
    accepted: false,
    reason: 'installation_disabled',
  });
  await store.update((state) => {
    state.installations['4'] = {
      id: '4', enabled: true, provider: 'openai', model: 'test', plan: 'free',
    };
  });
  assert.equal((await reserveReview(store, job, 1)).accepted, true);
  assert.deepEqual(await reserveReview(store, job, 1), {
    accepted: false,
    reason: 'duplicate',
  });
  assert.deepEqual(await reserveReview(store, { ...job, headSha: 'def' }, 1), {
    accepted: false,
    reason: 'quota_exceeded',
  });
});

test('signed installation webhook records the installer and defaults to disabled', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'second-opinion-hosted-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'state.json'));
  await store.init();
  const config = {
    publicUrl: 'http://127.0.0.1',
    webhookSecret: 'webhook-test-secret',
    workerConcurrency: 1,
    maxQueue: 10,
    reviewTimeoutMs: 60_000,
    rateLimitPerMinute: 2,
    monthlyReviewLimit: 3,
    models: { openai: ['test-model'] },
  };
  const server = createServer(config, store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const body = JSON.stringify({
    action: 'created',
    installation: { id: 12, account: { login: 'example' }, updated_at: '2026-09-06T08:00:00Z' },
    sender: { id: 34 },
  });
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/github/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'installation',
      'x-github-delivery': 'delivery-created',
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
    installation: { id: 12, account: { login: 'example' }, updated_at: '2026-09-06T09:00:00Z' },
    sender: { id: 34 },
  });
  await fetch(`http://127.0.0.1:${address.port}/github/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'installation',
      'x-github-delivery': 'delivery-suspended',
      'x-hub-signature-256': webhookSignature(config.webhookSecret, suspended),
    },
    body: suspended,
  });
  assert.equal(await store.read((state) => state.installations['12'].suspended), true);
  assert.equal(await store.read((state) => state.installations['12'].managerId), 34);
  assert.equal(await store.read((state) => state.jobs['12:9:2:abc'].status), 'cancelled');

  const duplicate = await fetch(`http://127.0.0.1:${address.port}/github/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'installation',
      'x-github-delivery': 'delivery-suspended',
      'x-hub-signature-256': webhookSignature(config.webhookSecret, suspended),
    },
    body: suspended,
  });
  assert.deepEqual(await duplicate.json(), { accepted: false, reason: 'duplicate_delivery' });

  const staleUnsuspend = JSON.stringify({
    action: 'unsuspend',
    installation: { id: 12, account: { login: 'example' }, updated_at: '2026-09-06T08:30:00Z' },
    sender: { id: 34 },
  });
  await fetch(`http://127.0.0.1:${address.port}/github/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'installation',
      'x-github-delivery': 'delivery-stale-unsuspend',
      'x-hub-signature-256': webhookSignature(config.webhookSecret, staleUnsuspend),
    },
    body: staleUnsuspend,
  });
  assert.equal(await store.read((state) => state.installations['12'].suspended), true);

  await store.update((state) => {
    state.sessions.session = { user: { id: 34 }, expiresAt: Date.now() + 60_000 };
  });
  const revoked = JSON.stringify({ action: 'revoked', sender: { id: 34 } });
  const revokedResponse = await fetch(`http://127.0.0.1:${address.port}/github/webhooks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'github_app_authorization',
      'x-github-delivery': 'delivery-revoked',
      'x-hub-signature-256': webhookSignature(config.webhookSecret, revoked),
    },
    body: revoked,
  });
  assert.equal(revokedResponse.status, 202);
  assert.equal(await store.read((state) => Object.keys(state.sessions).length), 0);
});
