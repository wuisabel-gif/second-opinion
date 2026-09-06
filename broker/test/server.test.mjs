import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBroker, serviceTokenAllowed } from '../src/server.mjs';
import { encryptAuthJson } from '../src/crypto.mjs';
import { InputError } from '../src/validation.mjs';
import { sampleAuthJson, testConfig } from '../test-support/helpers.mjs';

const REPOSITORY = 'owner/repo';
const CREDENTIAL_ID = randomUUID();

function claims(overrides = {}) {
  return {
    repository: REPOSITORY,
    repository_id: '12345',
    workflow_ref: 'owner/repo/.github/workflows/review.yml@refs/heads/main',
    event_name: 'pull_request_target',
    ref: 'refs/heads/main',
    jti: 'token-1',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

function reviewBody(overrides = {}) {
  return {
    task: 'pull_request_review',
    model: 'gpt-5.6-sol',
    repository: REPOSITORY,
    diff: 'diff --git a/src/a.rs b/src/a.rs',
    context: '',
    rules: '',
    ...overrides,
  };
}

function startBroker(t, depsOverrides = {}, configOverrides = {}) {
  const config = testConfig(configOverrides);
  const auth = sampleAuthJson();
  const encrypted = encryptAuthJson(auth, config.keyring, CREDENTIAL_ID);
  const updates = [];
  const registration = {
    repository: REPOSITORY,
    repository_id: 12345,
    credential_id: CREDENTIAL_ID,
    workflow_ref: claims().workflow_ref,
    job_workflow_ref: null,
    trusted_ref: 'refs/heads/main',
    event_name: 'pull_request_target',
    enabled: true,
  };
  const deps = {
    verifyOidc: async () => claims(),
    getRegistration: async () => registration,
    ensureServiceRegistration: async () => registration,
    consumeOidcAndRateLimit: async () => {},
    consumeServiceRateLimit: async () => {},
    ready: async () => {},
    withCredentialLock: async (_pool, _id, callback) =>
      callback(
        {
          query: async (sql, params) => {
            updates.push({ sql, params });
            return { rowCount: 1 };
          },
        },
        {
          key_version: encrypted.keyVersion,
          nonce: encrypted.nonce,
          auth_tag: encrypted.tag,
          ciphertext: encrypted.ciphertext,
        },
      ),
    runCodex: async () => ({
      output: Buffer.from(
        JSON.stringify({
          summary: 'one issue found',
          findings: [{ path: 'src/a.rs', line: 2, severity: 'medium', comment: 'fix this' }],
        }),
      ),
      refreshedAuth: null,
      error: null,
    }),
    ...depsOverrides,
  };
  const { server, gate, shutdown } = createBroker({ config, pool: {}, deps });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => {
        gate.close();
        server.close();
      });
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        updates,
        deps,
        shutdown,
      });
    });
  });
}

function postReview(base, { body = reviewBody(), headers = {} } = {}) {
  return fetch(`${base}/v1/reviews`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
      'x-second-opinion-protocol': '1',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function postInternalReview(base, { body = reviewBody(), token = 's'.repeat(32) } = {}) {
  return fetch(`${base}/v1/internal/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

test('compares service bearer tokens exactly', () => {
  assert.equal(serviceTokenAllowed(`Bearer ${'s'.repeat(32)}`, 's'.repeat(32)), true);
  assert.equal(serviceTokenAllowed(`Bearer ${'x'.repeat(32)}`, 's'.repeat(32)), false);
  assert.equal(serviceTokenAllowed(undefined, 's'.repeat(32)), false);
  assert.equal(serviceTokenAllowed(`Bearer ${'s'.repeat(32)}`, null), false);
});

test('health and readiness endpoints respond without credentials', async (t) => {
  const { base } = await startBroker(t);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 200);
});

test('completes a review end to end with the normalized contract', async (t) => {
  const { base } = await startBroker(t);
  const response = await postReview(base);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    summary: 'one issue found',
    findings: [{ path: 'src/a.rs', line: 2, severity: 'medium', comment: 'fix this' }],
  });
});

test('allows the hosted service endpoint with its dedicated token', async (t) => {
  const { base } = await startBroker(t, {}, { BROKER_SERVICE_TOKEN: 's'.repeat(32) });
  const response = await postInternalReview(base);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).summary, 'one issue found');
});

test('internal endpoint fails closed without the configured service token', async (t) => {
  const absent = await startBroker(t);
  assert.equal((await postInternalReview(absent.base)).status, 401);
  const configured = await startBroker(t, {}, { BROKER_SERVICE_TOKEN: 's'.repeat(32) });
  assert.equal((await postInternalReview(configured.base, { token: 'x'.repeat(32) })).status, 401);
});

test('hosted service can auto-enroll with the configured default credential', async (t) => {
  let ensured;
  const { base } = await startBroker(t, {
    getRegistration: async () => null,
    ensureServiceRegistration: async (_pool, repository, credentialId) => {
      ensured = { repository, credentialId };
      return {
        repository,
        credential_id: CREDENTIAL_ID,
        enabled: true,
      };
    },
  }, {
    BROKER_SERVICE_TOKEN: 's'.repeat(32),
    BROKER_DEFAULT_CREDENTIAL_ID: CREDENTIAL_ID,
  });
  assert.equal((await postInternalReview(base)).status, 200);
  assert.deepEqual(ensured, { repository: REPOSITORY, credentialId: CREDENTIAL_ID });
});

test('rejects unknown routes and wrong methods', async (t) => {
  const { base } = await startBroker(t);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/v1/reviews`, { method: 'GET' })).status, 404);
});

test('requires the protocol header', async (t) => {
  const { base } = await startBroker(t);
  const response = await postReview(base, { headers: { 'x-second-opinion-protocol': '2' } });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'unsupported_protocol');
});

test('rejects missing and invalid bearer tokens', async (t) => {
  const { base } = await startBroker(t, {
    verifyOidc: async () => {
      throw new InputError('OIDC token verification failed', 401, 'unauthorized');
    },
  });
  const missing = await fetch(`${base}/v1/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-second-opinion-protocol': '1' },
    body: JSON.stringify(reviewBody()),
  });
  assert.equal(missing.status, 401);
  const invalid = await postReview(base);
  assert.equal(invalid.status, 401);
});

test('rejects unenrolled repositories with 403', async (t) => {
  const { base } = await startBroker(t, { getRegistration: async () => null });
  const response = await postReview(base);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'forbidden');
});

test('rejects workflow identity mismatches with 403', async (t) => {
  const { base } = await startBroker(t, {
    verifyOidc: async () => claims({ workflow_ref: 'owner/repo/.github/workflows/evil.yml@refs/heads/main' }),
  });
  assert.equal((await postReview(base)).status, 403);
});

test('rejects a payload repository that differs from the token identity', async (t) => {
  const { base } = await startBroker(t);
  const response = await postReview(base, { body: reviewBody({ repository: 'owner/other' }) });
  assert.equal(response.status, 403);
});

test('maps replay and rate-limit rejections to their status codes', async (t) => {
  const replay = await startBroker(t, {
    consumeOidcAndRateLimit: async () => {
      throw new InputError('OIDC token has already been used', 401, 'oidc_replay');
    },
  });
  assert.equal((await postReview(replay.base)).status, 401);

  const limited = await startBroker(t, {
    consumeOidcAndRateLimit: async () => {
      throw new InputError('repository review rate limit exceeded', 429, 'rate_limited');
    },
  });
  const response = await postReview(limited.base);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'rate_limited');
});

test('maps Codex failures to 502 without leaking details', async (t) => {
  const { base } = await startBroker(t, {
    runCodex: async () => ({ output: null, refreshedAuth: null, error: new Error('secret upstream detail') }),
  });
  const response = await postReview(base);
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, 'upstream_failed');
  assert.ok(!JSON.stringify(body).includes('secret upstream detail'));
});

test('maps invalid Codex output to 502', async (t) => {
  const { base } = await startBroker(t, {
    runCodex: async () => ({ output: Buffer.from('not json'), refreshedAuth: null, error: null }),
  });
  assert.equal((await postReview(base)).status, 502);
});

test('maps output that fails normalization to 502', async (t) => {
  const { base } = await startBroker(t, {
    runCodex: async () => ({
      output: Buffer.from(JSON.stringify({ summary: 's', findings: [{ path: '../x', line: 1, severity: 'low', comment: 'c' }] })),
      refreshedAuth: null,
      error: null,
    }),
  });
  const response = await postReview(base);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'upstream_invalid');
});

test('rejects oversized request bodies', async (t) => {
  const { base } = await startBroker(t, {}, { BROKER_MAX_BODY_BYTES: '1024' });
  const response = await postReview(base, { body: reviewBody({ context: 'x'.repeat(5000) }) });
  assert.equal(response.status, 413);
});

test('rejects malformed JSON bodies', async (t) => {
  const { base } = await startBroker(t);
  const response = await postReview(base, { body: '{invalid' });
  assert.equal(response.status, 400);
});

test('rejects models outside the allowlist', async (t) => {
  const { base } = await startBroker(t);
  const response = await postReview(base, { body: reviewBody({ model: 'gpt-unlisted' }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'model_not_allowed');
});

test('persists a rotated credential under the credential lock', async (t) => {
  const rotated = sampleAuthJson('refresh-token-2');
  const { base, updates } = await startBroker(t, {
    runCodex: async () => ({
      output: Buffer.from(JSON.stringify({ summary: 'ok', findings: [] })),
      refreshedAuth: rotated,
      error: null,
    }),
  });
  const response = await postReview(base);
  assert.equal(response.status, 200);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /UPDATE broker_credentials/);
  assert.equal(updates[0].params[0], CREDENTIAL_ID);
});

test('skips the credential update when auth is unchanged', async (t) => {
  const { base, updates } = await startBroker(t);
  assert.equal((await postReview(base)).status, 200);
  assert.equal(updates.length, 0);
});

test('shutdown persists rotated auth before draining an active review', async (t) => {
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const rotated = sampleAuthJson('refresh-after-shutdown');
  const { base, updates, shutdown } = await startBroker(t, {
    runCodex: async ({ signal }) => {
      started();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return { output: null, refreshedAuth: rotated, error: new Error('cancelled') };
    },
  });
  const request = postReview(base);
  await running;
  await shutdown();
  const response = await request;
  assert.equal(response.status, 502);
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /UPDATE broker_credentials/);
});
