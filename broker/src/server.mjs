#!/usr/bin/env node
import http from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import {
  consumeOidcAndRateLimit,
  createDatabase,
  getRegistration,
  migrate,
  updateCredential,
  withCredentialLock,
} from './db.mjs';
import { decryptAuthJson, encryptAuthJson } from './crypto.mjs';
import { authorizeClaims, bearerToken, verifyGithubOidc } from './oidc.mjs';
import { ConcurrencyGate, runCodex } from './codex.mjs';
import {
  buildCodexPrompt,
  InputError,
  normalizeReview,
  validateReviewPayload,
} from './validation.mjs';

const PROTOCOL_VERSION = '1';
const JSON_CONTENT = { 'content-type': 'application/json; charset=utf-8' };

function log(event, fields = {}) {
  console.log(JSON.stringify({ level: 'info', event, ...fields }));
}

function logError(event, fields = {}) {
  console.error(JSON.stringify({ level: 'error', event, ...fields }));
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...JSON_CONTENT,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response, error) {
  if (error instanceof InputError) {
    sendJson(response, error.statusCode, { error: { code: error.code, message: error.message } });
    return;
  }
  sendJson(response, 500, { error: { code: 'internal', message: 'internal broker error' } });
}

async function readBoundedBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new InputError('request body exceeds its size limit', 413, 'payload_too_large');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InputError('request body must be valid JSON');
  }
}

function parseReviewOutput(output) {
  let parsed;
  try {
    parsed = JSON.parse(output.toString('utf8'));
  } catch {
    throw new InputError('review backend returned invalid output', 502, 'upstream_invalid');
  }
  return parsed;
}

export function createBroker({ config, pool, deps = {} }) {
  const verifyOidc = deps.verifyOidc ?? verifyGithubOidc;
  const findRegistration = deps.getRegistration ?? getRegistration;
  const consumeRate = deps.consumeOidcAndRateLimit ?? consumeOidcAndRateLimit;
  const withCredential = deps.withCredentialLock ?? withCredentialLock;
  const executeCodex = deps.runCodex ?? runCodex;
  const readyCheck = deps.ready ?? (async () => {
    await pool.query('SELECT 1');
  });
  const gate = deps.gate ?? new ConcurrencyGate(config.maxConcurrency, config.maxQueue);

  async function handleReview(request, response) {
    if (request.headers['x-second-opinion-protocol'] !== PROTOCOL_VERSION) {
      throw new InputError('unsupported broker protocol', 400, 'unsupported_protocol');
    }
    const claims = await verifyOidc(bearerToken(request.headers.authorization), config);
    const payload = await readBoundedBody(request, config.maxBodyBytes);
    const input = validateReviewPayload(payload, config);
    const registration = await findRegistration(pool, claims.repository);
    // Throws when the repository is unknown, disabled, or the workflow
    // identity does not exactly match the registered one.
    authorizeClaims(claims, registration, input.repository);

    await consumeRate(pool, claims, registration, config.perRepoHourlyLimit);

    const release = await gate.acquire();
    try {
      const review = await withCredential(pool, registration.credential_id, async (client, record) => {
        const authJson = decryptAuthJson(record, config.keyring, registration.credential_id);
        const prompt = buildCodexPrompt(input);
        const { output, refreshedAuth, error } = await executeCodex({
          authJson,
          prompt,
          model: input.model,
          config,
        });

        try {
          if (refreshedAuth && !refreshedAuth.equals(authJson)) {
            const encrypted = encryptAuthJson(refreshedAuth, config.keyring, registration.credential_id);
            await updateCredential(client, registration.credential_id, encrypted);
            log('credential_refreshed', { repository: registration.repository });
          }
        } finally {
          authJson.fill(0);
          if (refreshedAuth) refreshedAuth.fill(0);
        }

        if (error || !output) {
          throw new InputError('review backend failed', 502, 'upstream_failed');
        }
        try {
          return normalizeReview(parseReviewOutput(output), config);
        } catch (error) {
          if (error instanceof InputError) throw error;
          throw new InputError('review backend returned invalid output', 502, 'upstream_invalid');
        }
      });

      log('review_completed', {
        repository: registration.repository,
        model: input.model,
        findings: review.findings.length,
      });
      sendJson(response, 200, review);
    } finally {
      release();
    }
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://broker.local');
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/readyz') {
        await readyCheck();
        sendJson(response, 200, { status: 'ready' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/reviews') {
        await handleReview(request, response);
        return;
      }
      throw new InputError('not found', 404, 'not_found');
    } catch (error) {
      if (!(error instanceof InputError)) {
        logError('unhandled_request_error', { path: url.pathname, message: error?.message });
      }
      sendError(response, error);
    }
  });

  server.requestTimeout = config.codexTimeoutMs + 120_000;
  server.headersTimeout = 65_000;
  return { server, gate };
}

async function main() {
  const config = loadConfig();
  const pool = createDatabase(config);
  await migrate(pool);
  const { server, gate } = createBroker({ config, pool });

  const shutdown = (signal) => {
    log('shutdown_started', { signal });
    gate.close();
    server.close(() => {
      pool.end()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, resolve);
  });
  log('broker_listening', { port: config.port });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    logError('broker_start_failed', { message: error.message });
    process.exitCode = 1;
  });
}
