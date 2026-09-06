import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeOidcAndRateLimit,
  consumeServiceRateLimit,
  ensureServiceRegistration,
} from '../src/db.mjs';
import { InputError } from '../src/validation.mjs';

function fakePool(handler) {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return handler(sql, params, queries);
    },
    release() {},
  };
  return { pool: { connect: async () => client, query: client.query }, queries };
}

const registration = { repository: 'owner/repo' };
const claims = { jti: 'unique-token', exp: Math.floor(Date.now() / 1000) + 300 };

test('OIDC usage requires a replay identifier', async () => {
  const { pool } = fakePool(() => ({ rowCount: 1, rows: [{ count: 0 }] }));
  await assert.rejects(
    consumeOidcAndRateLimit(pool, { exp: claims.exp }, registration, 20),
    (error) => error instanceof InputError && error.code === 'unauthorized',
  );
});

test('OIDC usage rejects a replayed token', async () => {
  const { pool } = fakePool((sql) => {
    if (sql.includes('INSERT INTO broker_oidc_replays')) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [{ count: 0 }] };
  });
  await assert.rejects(
    consumeOidcAndRateLimit(pool, claims, registration, 20),
    (error) => error instanceof InputError && error.code === 'oidc_replay',
  );
});

test('OIDC usage records its source after replay and rate checks', async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes('SELECT count')) return { rows: [{ count: 0 }] };
    return { rowCount: 1, rows: [{ jti: claims.jti }] };
  });
  await consumeOidcAndRateLimit(pool, claims, registration, 20);
  const usage = queries.find((entry) => entry.sql.includes('INSERT INTO broker_usage_events'));
  assert.deepEqual(usage.params, ['owner/repo', 'oidc']);
});

test('service usage enforces its global hourly ceiling', async () => {
  const { pool } = fakePool((sql) => {
    if (sql.includes("WHERE source = 'service'")) return { rows: [{ count: 100 }] };
    return { rowCount: 1, rows: [{ count: 0 }] };
  });
  await assert.rejects(
    consumeServiceRateLimit(pool, registration, 20, 100),
    (error) => error instanceof InputError && error.code === 'rate_limited',
  );
});

test('service usage records service source', async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes('SELECT count')) return { rows: [{ count: 0 }] };
    return { rowCount: 1, rows: [] };
  });
  await consumeServiceRateLimit(pool, registration, 20, 100);
  const usage = queries.find((entry) => entry.sql.includes('INSERT INTO broker_usage_events'));
  assert.deepEqual(usage.params, ['owner/repo', 'service']);
  const locks = queries
    .filter((entry) => entry.sql.includes('pg_advisory_xact_lock'))
    .map((entry) => entry.params[0]);
  assert.deepEqual(locks, ['rate:service:global', 'rate:owner/repo']);
});

test('hosted auto-enrollment never overwrites an existing registration', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('SELECT repository')) {
        return { rows: [{ repository: 'owner/repo', credential_id: 'credential', enabled: false }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
  const result = await ensureServiceRegistration(pool, 'owner/repo', 'credential');
  assert.equal(result.enabled, false);
  assert.match(queries[0].sql, /ON CONFLICT \(repository\) DO NOTHING/);
});
