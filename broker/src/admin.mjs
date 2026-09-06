#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { loadConfig } from './config.mjs';
import { createDatabase, migrate } from './db.mjs';
import { decryptAuthJson, encryptAuthJson, validateAuthJson } from './crypto.mjs';
import { validateRepository } from './validation.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (!name.startsWith('--')) throw new Error(`unexpected argument: ${name}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
    flags.set(name.slice(2), value);
    index += 1;
  }
  return { command, flags };
}

function requiredFlag(flags, name) {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function readStdin(maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('stdin exceeded the credential size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function loadAuthFile(path) {
  return validateAuthJson(path === '-' ? await readStdin() : await readFile(path));
}

function validateUuid(value, name) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
  return value;
}

function validateRegistration(repository, flags) {
  const credentialId = validateUuid(requiredFlag(flags, 'credential-id'), '--credential-id');
  const repositoryIdRaw = requiredFlag(flags, 'repository-id');
  if (!/^\d+$/.test(repositoryIdRaw) || repositoryIdRaw === '0') {
    throw new Error('--repository-id must be a positive numeric GitHub repository ID');
  }
  const workflowRef = requiredFlag(flags, 'workflow-ref');
  if (!workflowRef.startsWith(`${repository}/.github/workflows/`) || !workflowRef.includes('@refs/heads/')) {
    throw new Error('--workflow-ref must be an exact owner/repo/.github/workflows/file.yml@refs/heads/branch value');
  }
  const trustedRef = flags.get('ref')?.trim() || 'refs/heads/main';
  if (!trustedRef.startsWith('refs/heads/')) throw new Error('--ref must be an exact refs/heads/... value');
  const eventName = flags.get('event-name')?.trim() || 'pull_request_target';
  if (!/^[A-Za-z0-9_]+$/.test(eventName)) throw new Error('--event-name is invalid');
  const jobWorkflowRef = flags.get('job-workflow-ref')?.trim() || null;
  return {
    credentialId,
    repositoryId: repositoryIdRaw,
    workflowRef,
    trustedRef,
    eventName,
    jobWorkflowRef,
  };
}

async function enroll(pool, config, flags) {
  const label = requiredFlag(flags, 'label');
  if (label.length > 200) throw new Error('--label is too long');
  const auth = await loadAuthFile(requiredFlag(flags, 'auth-file'));
  const credentialId = randomUUID();
  try {
    const encrypted = encryptAuthJson(auth, config.keyring, credentialId);
    await pool.query(
      `INSERT INTO broker_credentials
       (id, label, key_version, nonce, auth_tag, ciphertext)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [credentialId, label, encrypted.keyVersion, encrypted.nonce, encrypted.tag, encrypted.ciphertext],
    );
    console.log(JSON.stringify({ credential_id: credentialId, label }));
  } finally {
    auth.fill(0);
  }
}

async function register(pool, flags) {
  const repository = validateRepository(requiredFlag(flags, 'repository'));
  const values = validateRegistration(repository, flags);
  await pool.query(
    `INSERT INTO broker_repositories
       (repository, repository_id, credential_id, workflow_ref, job_workflow_ref,
        trusted_ref, event_name, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
     ON CONFLICT (repository) DO UPDATE SET
       repository_id = EXCLUDED.repository_id,
       credential_id = EXCLUDED.credential_id,
       workflow_ref = EXCLUDED.workflow_ref,
       job_workflow_ref = EXCLUDED.job_workflow_ref,
       trusted_ref = EXCLUDED.trusted_ref,
       event_name = EXCLUDED.event_name,
       enabled = TRUE,
       updated_at = now()`,
    [
      repository,
      values.repositoryId,
      values.credentialId,
      values.workflowRef,
      values.jobWorkflowRef,
      values.trustedRef,
      values.eventName,
    ],
  );
  console.log(JSON.stringify({ repository, enabled: true }));
}

async function setEnabled(pool, flags, enabled) {
  const repository = validateRepository(requiredFlag(flags, 'repository'));
  const result = await pool.query(
    'UPDATE broker_repositories SET enabled = $2, updated_at = now() WHERE repository = $1',
    [repository, enabled],
  );
  if (result.rowCount !== 1) throw new Error('repository is not registered');
  console.log(JSON.stringify({ repository, enabled }));
}

async function list(pool) {
  const result = await pool.query(
    `SELECT r.repository, r.repository_id, r.workflow_ref, r.job_workflow_ref,
            r.trusted_ref, r.event_name, r.enabled, c.id AS credential_id, c.label,
            c.key_version
       FROM broker_repositories r
       JOIN broker_credentials c ON c.id = r.credential_id
      ORDER BY r.repository`,
  );
  console.log(JSON.stringify(result.rows, null, 2));
}

async function rotateKeys(pool, config) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('broker-key-rotation', 0))");
    const result = await client.query(
      'SELECT id, key_version, nonce, auth_tag, ciphertext FROM broker_credentials FOR UPDATE',
    );
    for (const row of result.rows) {
      if (row.key_version === config.keyring.activeVersion) continue;
      const plaintext = decryptAuthJson(row, config.keyring, row.id);
      try {
        const encrypted = encryptAuthJson(plaintext, config.keyring, row.id);
        await client.query(
          `UPDATE broker_credentials
              SET key_version = $2, nonce = $3, auth_tag = $4, ciphertext = $5, updated_at = now()
            WHERE id = $1`,
          [row.id, encrypted.keyVersion, encrypted.nonce, encrypted.tag, encrypted.ciphertext],
        );
      } finally {
        plaintext.fill(0);
      }
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ rotated: result.rowCount, active_key_version: config.keyring.activeVersion }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function usage() {
  return `Usage:
  npm run admin -- enroll --label NAME --auth-file PATH|-
  npm run admin -- register --repository OWNER/REPO --repository-id ID --credential-id UUID \\
    --workflow-ref OWNER/REPO/.github/workflows/review.yml@refs/heads/main [--ref refs/heads/main] \\
    [--event-name pull_request_target] [--job-workflow-ref EXACT_REF]
  npm run admin -- disable --repository OWNER/REPO
  npm run admin -- enable --repository OWNER/REPO
  npm run admin -- list
  npm run admin -- rotate-keys`;
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help') {
    console.log(usage());
    return;
  }
  const config = loadConfig();
  const pool = createDatabase(config);
  try {
    await migrate(pool);
    if (command === 'enroll') await enroll(pool, config, flags);
    else if (command === 'register') await register(pool, flags);
    else if (command === 'disable') await setEnabled(pool, flags, false);
    else if (command === 'enable') await setEnabled(pool, flags, true);
    else if (command === 'list') await list(pool);
    else if (command === 'rotate-keys') await rotateKeys(pool, config);
    else throw new Error(`unknown command: ${command}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`broker admin failed: ${error.message}`);
  process.exitCode = 1;
});
