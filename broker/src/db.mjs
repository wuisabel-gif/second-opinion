import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { InputError } from './validation.mjs';

const { Pool } = pg;
const MIGRATION_LOCK = 'second-opinion-broker-migrations-v1';

export function createDatabase(config) {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolSize,
    application_name: 'second-opinion-broker',
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', () => {
    console.error(JSON.stringify({ level: 'error', event: 'idle_database_client_error' }));
  });
  return pool;
}

export async function migrate(pool) {
  const sql = await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [MIGRATION_LOCK]);
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function ready(pool) {
  await pool.query('SELECT 1');
}

export async function getRegistration(pool, repository) {
  const result = await pool.query(
    `SELECT repository, repository_id, credential_id, workflow_ref,
            job_workflow_ref, trusted_ref, event_name, enabled
       FROM broker_repositories
      WHERE repository = $1`,
    [repository],
  );
  return result.rows[0] ?? null;
}

export async function ensureServiceRegistration(pool, repository, credentialId) {
  await pool.query(
    `INSERT INTO broker_repositories
       (repository, repository_id, credential_id, workflow_ref, job_workflow_ref,
        trusted_ref, event_name, enabled)
     VALUES ($1, NULL, $2, NULL, NULL, '', 'hosted_service', TRUE)
     ON CONFLICT (repository) DO NOTHING`,
    [repository, credentialId],
  );
  return getRegistration(pool, repository);
}

export async function consumeOidcAndRateLimit(pool, claims, registration, hourlyLimit) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `rate:${registration.repository}`,
    ]);
    await client.query('DELETE FROM broker_oidc_replays WHERE expires_at < now()');
    await client.query("DELETE FROM broker_usage_events WHERE requested_at < now() - interval '2 hours'");

    if (typeof claims.jti !== 'string' || !claims.jti) {
      throw new InputError('OIDC token has no replay identifier', 401, 'unauthorized');
    }
    const replay = await client.query(
      `INSERT INTO broker_oidc_replays (jti, expires_at)
       VALUES ($1, to_timestamp($2))
       ON CONFLICT (jti) DO NOTHING
       RETURNING jti`,
      [claims.jti, Number(claims.exp)],
    );
    if (replay.rowCount !== 1) {
      throw new InputError('OIDC token has already been used', 401, 'oidc_replay');
    }

    await consumeRateWithinTransaction(client, registration, hourlyLimit);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function consumeRateWithinTransaction(client, registration, hourlyLimit, source = 'oidc') {
  const usage = await client.query(
    `SELECT count(*)::integer AS count
       FROM broker_usage_events
      WHERE repository = $1
        AND requested_at >= now() - interval '1 hour'`,
    [registration.repository],
  );
  if (usage.rows[0].count >= hourlyLimit) {
    throw new InputError('repository review rate limit exceeded', 429, 'rate_limited');
  }
  await client.query('INSERT INTO broker_usage_events (repository, source) VALUES ($1, $2)', [
    registration.repository,
    source,
  ]);
}

export async function consumeServiceRateLimit(pool, registration, hourlyLimit, globalHourlyLimit) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      'rate:service:global',
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `rate:${registration.repository}`,
    ]);
    await client.query("DELETE FROM broker_usage_events WHERE requested_at < now() - interval '2 hours'");
    const globalUsage = await client.query(
      `SELECT count(*)::integer AS count
         FROM broker_usage_events
        WHERE source = 'service'
          AND requested_at >= now() - interval '1 hour'`,
    );
    if (globalUsage.rows[0].count >= globalHourlyLimit) {
      throw new InputError('hosted service review rate limit exceeded', 429, 'rate_limited');
    }
    await consumeRateWithinTransaction(client, registration, hourlyLimit, 'service');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function withCredentialLock(pool, credentialId, callback) {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
      `credential:${credentialId}`,
    ]);
    locked = true;
    const result = await client.query(
      `SELECT id, label, key_version, nonce, auth_tag, ciphertext
         FROM broker_credentials
        WHERE id = $1`,
      [credentialId],
    );
    if (result.rowCount !== 1) throw new Error('registered credential is unavailable');
    return await callback(client, result.rows[0]);
  } finally {
    if (locked) {
      await client
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`credential:${credentialId}`])
        .catch(() => {});
    }
    client.release();
  }
}

export async function updateCredential(client, credentialId, encrypted) {
  const result = await client.query(
    `UPDATE broker_credentials
        SET key_version = $2, nonce = $3, auth_tag = $4, ciphertext = $5, updated_at = now()
      WHERE id = $1`,
    [
      credentialId,
      encrypted.keyVersion,
      encrypted.nonce,
      encrypted.tag,
      encrypted.ciphertext,
    ],
  );
  if (result.rowCount !== 1) throw new Error('credential update failed');
}
