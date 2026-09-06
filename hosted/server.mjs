#!/usr/bin/env node

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  sign,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const API_VERSION = '2022-11-28';
const REVIEW_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DELIVERY_IDS = 10_000;
const REVIEWER_KILL_GRACE_MS = 2_000;
const MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

function nonEmpty(value) {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || undefined;
}

function required(env, name) {
  const value = nonEmpty(env[name]);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePositiveInteger(value, fallback, name) {
  if (!nonEmpty(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const publicUrl = new URL(required(env, 'PUBLIC_URL'));
  if (publicUrl.protocol !== 'https:' && env.ALLOW_INSECURE_HTTP !== 'true') {
    throw new Error('PUBLIC_URL must use HTTPS');
  }
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash
    || !['', '/'].includes(publicUrl.pathname)) {
    throw new Error('PUBLIC_URL must be an origin without credentials, path, query, or fragment');
  }

  const sessionSecret = required(env, 'SESSION_SECRET');
  if (Buffer.byteLength(sessionSecret) < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 bytes');
  }
  const webhookSecret = required(env, 'GITHUB_WEBHOOK_SECRET');
  if (Buffer.byteLength(webhookSecret) < 32) {
    throw new Error('GITHUB_WEBHOOK_SECRET must contain at least 32 bytes');
  }
  const appId = required(env, 'GITHUB_APP_ID');
  if (!/^\d+$/.test(appId)) throw new Error('GITHUB_APP_ID must be numeric');

  const models = {};
  if (nonEmpty(env.OPENAI_API_KEY)) {
    models.openai = (nonEmpty(env.HOSTED_OPENAI_MODELS) || 'gpt-5.6-sol')
      .split(',').map((value) => value.trim()).filter(Boolean);
  }
  if (nonEmpty(env.ANTHROPIC_API_KEY)) {
    models.anthropic = (nonEmpty(env.HOSTED_ANTHROPIC_MODELS) || 'claude-sonnet-4-6')
      .split(',').map((value) => value.trim()).filter(Boolean);
  }
  const codexBrokerUrl = nonEmpty(env.CODEX_BROKER_URL);
  const codexBrokerToken = nonEmpty(env.CODEX_BROKER_TOKEN);
  if (Boolean(codexBrokerUrl) !== Boolean(codexBrokerToken)) {
    throw new Error('CODEX_BROKER_URL and CODEX_BROKER_TOKEN must be configured together');
  }
  if (codexBrokerUrl) {
    const parsed = new URL(codexBrokerUrl);
    if (parsed.protocol !== 'https:' && env.ALLOW_INSECURE_HTTP !== 'true') {
      throw new Error('CODEX_BROKER_URL must use HTTPS');
    }
    if (Buffer.byteLength(codexBrokerToken) < 32) {
      throw new Error('CODEX_BROKER_TOKEN must contain at least 32 bytes');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash
      || !['', '/'].includes(parsed.pathname)) {
      throw new Error('CODEX_BROKER_URL must be an origin without credentials, path, query, or fragment');
    }
    models['codex-broker'] = (nonEmpty(env.HOSTED_CODEX_MODELS) || 'gpt-5.6-sol')
      .split(',').map((value) => value.trim()).filter(Boolean);
  }
  if (Object.keys(models).length === 0) {
    throw new Error('OPENAI_API_KEY, ANTHROPIC_API_KEY, or a Codex broker is required');
  }
  if (Object.values(models).some((offered) => offered.length === 0)) {
    throw new Error('each configured provider must offer at least one model');
  }

  return {
    port: parsePositiveInteger(env.PORT, 3000, 'PORT'),
    host: nonEmpty(env.HOST) || '127.0.0.1',
    publicUrl: publicUrl.toString().replace(/\/$/, ''),
    allowInsecureHttp: env.ALLOW_INSECURE_HTTP === 'true',
    webhookSecret,
    appId,
    appSlug: required(env, 'GITHUB_APP_SLUG'),
    clientId: required(env, 'GITHUB_CLIENT_ID'),
    clientSecret: required(env, 'GITHUB_CLIENT_SECRET'),
    privateKey: required(env, 'GITHUB_PRIVATE_KEY').replace(/\\n/g, '\n'),
    botLogin: required(env, 'GITHUB_BOT_LOGIN'),
    sessionSecret,
    statePath: nonEmpty(env.HOSTED_STATE_PATH) || './hosted-state.json',
    reviewerBinary: nonEmpty(env.REVIEWER_BINARY) || 'second-opinion',
    monthlyReviewLimit: parsePositiveInteger(
      env.HOSTED_MONTHLY_REVIEW_LIMIT,
      25,
      'HOSTED_MONTHLY_REVIEW_LIMIT',
    ),
    workerConcurrency: parsePositiveInteger(env.HOSTED_WORKERS, 2, 'HOSTED_WORKERS'),
    rateLimitPerMinute: parsePositiveInteger(
      env.HOSTED_RATE_LIMIT_PER_MINUTE,
      10,
      'HOSTED_RATE_LIMIT_PER_MINUTE',
    ),
    maxQueue: parsePositiveInteger(env.HOSTED_MAX_QUEUE, 100, 'HOSTED_MAX_QUEUE'),
    reviewTimeoutMs: parsePositiveInteger(
      env.HOSTED_REVIEW_TIMEOUT_SECONDS,
      20 * 60,
      'HOSTED_REVIEW_TIMEOUT_SECONDS',
    ) * 1000,
    codexBrokerUrl,
    codexBrokerToken,
    models,
  };
}

function defaultState() {
  return { installations: {}, jobs: {}, usage: {}, sessions: {}, deliveries: {} };
}

export class JsonStore {
  constructor(path) {
    this.path = path;
    this.data = defaultState();
    this.pending = Promise.resolve();
  }

  async init() {
    let loaded = false;
    try {
      this.data = { ...defaultState(), ...JSON.parse(await fs.readFile(this.path, 'utf8')) };
      loaded = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let recovered = false;
    for (const job of Object.values(this.data.jobs)) {
      if (job.status === 'running' && job.job) {
        job.status = 'queued';
        job.updatedAt = Date.now();
        recovered = true;
      }
    }
    this.prune();
    if (loaded || recovered) await this.save();
  }

  async read(callback) {
    await this.pending;
    return callback(this.data);
  }

  async update(callback) {
    const operation = this.pending.then(async () => {
      const result = callback(this.data);
      this.prune();
      await this.save();
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  prune(now = Date.now()) {
    for (const [key, job] of Object.entries(this.data.jobs)) {
      if (now - job.createdAt > JOB_RETENTION_MS) delete this.data.jobs[key];
    }
    for (const [key, session] of Object.entries(this.data.sessions)) {
      if (session.expiresAt <= now) delete this.data.sessions[key];
    }
    for (const [key, receivedAt] of Object.entries(this.data.deliveries)) {
      if (now - receivedAt > DELIVERY_RETENTION_MS) delete this.data.deliveries[key];
    }
    const deliveries = Object.entries(this.data.deliveries);
    if (deliveries.length > MAX_DELIVERY_IDS) {
      deliveries.sort((left, right) => left[1] - right[1]);
      for (const [key] of deliveries.slice(0, deliveries.length - MAX_DELIVERY_IDS)) {
        delete this.data.deliveries[key];
      }
    }
    const currentMonth = new Date(now).toISOString().slice(0, 7);
    for (const key of Object.keys(this.data.usage)) {
      if (!key.endsWith(`:${currentMonth}`)) delete this.data.usage[key];
    }
  }

  async save() {
    const temporary = `${this.path}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.path);
  }
}

function monthKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 7);
}

function newInstallation(id, account, managerId, config, lifecycleAt) {
  const provider = Object.keys(config.models)[0];
  return {
    id: String(id),
    account,
    managerId,
    enabled: false,
    suspended: false,
    provider,
    model: config.models[provider][0],
    plan: 'free',
    lifecycleAt,
    updatedAt: Date.now(),
  };
}

function cancelInstallationJobs(state, installationId) {
  const prefix = `${installationId}:`;
  for (const [key, job] of Object.entries(state.jobs)) {
    if (key.startsWith(prefix) && ['queued', 'running'].includes(job.status)) {
      job.status = 'cancelled';
      job.updatedAt = Date.now();
    }
  }
}

async function upsertInstallation(store, id, account, managerId, config, suspended, lifecycleAt) {
  return store.update((state) => {
    const key = String(id);
    state.installations[key] ||= newInstallation(key, account, managerId, config, lifecycleAt);
    if ((state.installations[key].lifecycleAt || 0) > lifecycleAt) {
      return state.installations[key];
    }
    state.installations[key].account = account || state.installations[key].account;
    state.installations[key].managerId ||= managerId;
    if (suspended !== undefined) state.installations[key].suspended = suspended;
    if (suspended) cancelInstallationJobs(state, key);
    state.installations[key].lifecycleAt = lifecycleAt;
    state.installations[key].updatedAt = Date.now();
    return state.installations[key];
  });
}

async function deleteInstallation(store, id) {
  return store.update((state) => {
    const prefix = `${id}:`;
    delete state.installations[String(id)];
    for (const key of Object.keys(state.jobs)) {
      if (key.startsWith(prefix)) delete state.jobs[key];
    }
    for (const key of Object.keys(state.usage)) {
      if (key.startsWith(prefix)) delete state.usage[key];
    }
  });
}

async function deleteUserSessions(store, userId) {
  return store.update((state) => {
    for (const [key, session] of Object.entries(state.sessions)) {
      if (session.user?.id === userId) delete state.sessions[key];
    }
  });
}

async function reserveDelivery(store, deliveryId) {
  if (typeof deliveryId !== 'string' || !/^[A-Za-z0-9-]{1,200}$/.test(deliveryId)) {
    throw Object.assign(new Error('GitHub delivery id is missing or invalid'), { statusCode: 400 });
  }
  return store.update((state) => {
    if (state.deliveries[deliveryId]) return false;
    state.deliveries[deliveryId] = Date.now();
    return true;
  });
}

export async function reserveReview(store, job, limit, now = Date.now()) {
  return store.update((state) => {
    const installation = state.installations[String(job.installationId)];
    if (!installation?.enabled) return { accepted: false, reason: 'installation_disabled' };
    if (installation.suspended) return { accepted: false, reason: 'installation_suspended' };

    const jobKey = `${job.installationId}:${job.repositoryId}:${job.pullNumber}:${job.headSha}`;
    const existing = state.jobs[jobKey];
    if (existing && existing.status !== 'failed') {
      return { accepted: false, reason: 'duplicate' };
    }

    const usageKey = `${job.installationId}:${monthKey(now)}`;
    const used = state.usage[usageKey] || 0;
    if (used >= limit) return { accepted: false, reason: 'quota_exceeded' };

    state.usage[usageKey] = used + 1;
    state.jobs[jobKey] = { status: 'queued', job, createdAt: now, updatedAt: now };
    return { accepted: true, jobKey, installation: { ...installation } };
  });
}

async function setJobStatus(store, jobKey, status) {
  return store.update((state) => {
    if (state.jobs[jobKey]) {
      state.jobs[jobKey].status = status;
      state.jobs[jobKey].updatedAt = Date.now();
    }
  });
}

export function verifyWebhookSignature(secret, rawBody, signatureHeader) {
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const supplied = Buffer.from(signatureHeader);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

export function createAppJwt(appId, privateKey, now = Math.floor(Date.now() / 1000)) {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

async function githubRequest(path, { token, method = 'GET', body, signal } = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'second-opinion-hosted',
      'x-github-api-version': API_VERSION,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`GitHub API ${method} ${path} returned ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

async function installationToken(config, installationId, repositoryId, signal) {
  const jwt = createAppJwt(config.appId, config.privateKey);
  const result = await githubRequest(`/app/installations/${installationId}/access_tokens`, {
    token: jwt,
    method: 'POST',
    body: {
      repository_ids: [repositoryId],
      permissions: { contents: 'read', pull_requests: 'write' },
    },
    signal,
  });
  return result.token;
}

export function reviewerEnvironment(config, installation, token, job) {
  let provider = installation.provider;
  let credential = provider === 'anthropic'
    ? process.env.ANTHROPIC_API_KEY
    : process.env.OPENAI_API_KEY;
  const allowedEnvironment = [
    'PATH',
    'HOME',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ];
  const environment = Object.fromEntries(
    allowedEnvironment.filter((name) => process.env[name]).map((name) => [name, process.env[name]]),
  );
  const result = {
    ...environment,
    GITHUB_TOKEN: token,
    GITHUB_REPOSITORY: job.repository,
    PR_NUMBER: String(job.pullNumber),
    REVIEW_PROVIDER: provider,
    REVIEW_MODEL: installation.model,
    REVIEW_API_KEY: credential,
    REVIEW_BOT_LOGIN: config.botLogin,
    EXPECTED_HEAD_SHA: job.headSha,
  };
  if (provider === 'codex-broker') {
    provider = 'webhook';
    credential = config.codexBrokerToken;
    result.REVIEW_PROVIDER = provider;
    result.REVIEW_API_KEY = credential;
    result.REVIEW_ENDPOINT = new URL('/v1/internal/reviews', config.codexBrokerUrl).toString();
    result.REVIEW_AUTH_HEADER = 'Authorization';
    result.REVIEW_AUTH_SCHEME = 'Bearer';
  }
  return result;
}

export async function spawnReviewer(config, installation, token, job, signal) {
  await new Promise((resolve, reject) => {
    const child = spawn(config.reviewerBinary, [], {
      env: reviewerEnvironment(config, installation, token, job),
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: process.platform !== 'win32',
    });
    let timedOut = false;
    let killTimer;
    const signalTree = (signalName) => {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signalName);
          return;
        } catch {
          // Fall back to the direct child when no process group exists.
        }
      }
      child.kill(signalName);
    };
    const abort = () => {
      signalTree('SIGTERM');
      killTimer ||= setTimeout(() => signalTree('SIGKILL'), REVIEWER_KILL_GRACE_MS);
      killTimer.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      abort();
    }, config.reviewTimeoutMs);
    timeout.unref();
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('exit', (code, signalName) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      if (timedOut) reject(new Error('reviewer timed out'));
      else if (code === 0) resolve();
      else reject(new Error(`reviewer exited with ${code ?? signalName}`));
    });
    if (signal.aborted) abort();
  });
}

export function createQueue(concurrency, maxQueue, worker) {
  const jobs = [];
  let active = 0;
  let closed = false;
  const idleWaiters = [];
  const notifyIdle = () => {
    if (active === 0 && jobs.length === 0) {
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
  };
  const pump = () => {
    while (active < concurrency && jobs.length) {
      active += 1;
      Promise.resolve(worker(jobs.shift()))
        .catch(() => {})
        .finally(() => {
          active -= 1;
          pump();
          notifyIdle();
        });
    }
  };
  const enqueue = (job) => {
    if (closed) return false;
    if (jobs.length >= maxQueue) return false;
    jobs.push(job);
    pump();
    return true;
  };
  enqueue.close = () => {
    closed = true;
    const pending = jobs.splice(0);
    notifyIdle();
    return pending;
  };
  enqueue.waitForIdle = () => {
    if (active === 0 && jobs.length === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  };
  return enqueue;
}

function createReviewQueue(config, store) {
  const active = new Map();
  const enqueue = createQueue(config.workerConcurrency, config.maxQueue, async ({ job, jobKey }) => {
    const installationId = String(job.installationId);
    const controller = new AbortController();
    const controllers = active.get(installationId) || new Set();
    controllers.add(controller);
    active.set(installationId, controllers);
    try {
      const installation = await store.read((state) => state.installations[installationId]);
      if (!installation?.enabled || installation.suspended || controller.signal.aborted) {
        await setJobStatus(store, jobKey, 'cancelled');
        return;
      }
      await setJobStatus(store, jobKey, 'running');
      const token = await installationToken(
        config,
        job.installationId,
        job.repositoryId,
        controller.signal,
      );
      const pull = await githubRequest(`/repos/${job.repository}/pulls/${job.pullNumber}`, {
        token,
        signal: controller.signal,
      });
      if (pull.head?.sha !== job.headSha) {
        await setJobStatus(store, jobKey, 'superseded');
        return;
      }
      await spawnReviewer(config, installation, token, job, controller.signal);
      await setJobStatus(store, jobKey, 'succeeded');
      console.log(`review succeeded for ${job.repository}#${job.pullNumber}`);
    } catch (error) {
      const status = controller.signal.reason === 'shutdown'
        ? 'queued'
        : controller.signal.aborted ? 'cancelled' : 'failed';
      await setJobStatus(
        store,
        jobKey,
        status,
      );
      if (!controller.signal.aborted) {
        console.error(`review failed for ${job.repository}#${job.pullNumber}: ${error.message}`);
      }
    } finally {
      controllers.delete(controller);
      if (controllers.size === 0) active.delete(installationId);
    }
  });
  return {
    enqueue,
    cancel(installationId) {
      for (const controller of active.get(String(installationId)) || []) controller.abort();
    },
    async shutdown() {
      // Pending records remain queued in persistent state and are recovered on restart.
      enqueue.close();
      for (const controllers of active.values()) {
        for (const controller of controllers) controller.abort('shutdown');
      }
      await enqueue.waitForIdle();
    },
  };
}

function readBody(req, maximum = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximum) {
        const error = new Error('request body too large');
        error.statusCode = 413;
        reject(error);
        req.removeAllListeners('data');
        req.resume();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, { location, 'set-cookie': cookies, 'cache-control': 'no-store' });
  res.end();
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return [];
    return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1))]];
  }));
}

function cookie(name, value, config, options = '') {
  const secure = config.allowInsecureHttp ? '' : '; Secure';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax${secure}${options}`;
}

function constantTimeStringEqual(first, second) {
  const left = Buffer.from(first || '');
  const right = Buffer.from(second || '');
  return left.length === right.length && timingSafeEqual(left, right);
}

function signedValue(value, secret) {
  const encoded = base64Url(value);
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function readSignedValue(value, secret) {
  const [encoded, signature, extra] = (value || '').split('.');
  if (!encoded || !signature || extra) return null;
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  if (!constantTimeStringEqual(signature, expected)) return null;
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

function encryptionKey(secret) {
  return createHash('sha256').update(secret).digest();
}

function seal(value, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function unseal(value, secret) {
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function hashSessionId(id) {
  return createHash('sha256').update(id).digest('hex');
}

async function createSession(store, config, user, accessToken) {
  const id = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  await store.update((state) => {
    state.sessions[hashSessionId(id)] = {
      user: { id: user.id, login: user.login },
      token: seal(accessToken, config.sessionSecret),
      csrf,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
  });
  return { id, csrf };
}

async function currentSession(req, store, config) {
  const id = parseCookies(req).second_opinion_session;
  if (!id) return null;
  const sessionKey = hashSessionId(id);
  return store.read((state) => {
    const session = state.sessions[sessionKey];
    if (!session || session.expiresAt <= Date.now()) return null;
    try {
      return { ...session, sessionKey, accessToken: unseal(session.token, config.sessionSecret) };
    } catch {
      return null;
    }
  });
}

async function listUserInstallations(accessToken) {
  const installations = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await githubRequest(`/user/installations?per_page=100&page=${page}`, {
      token: accessToken,
    });
    installations.push(...result.installations);
    if (result.installations.length < 100) break;
  }
  return installations;
}

function validOrigin(req, config) {
  try {
    return new URL(req.headers.origin).origin === new URL(config.publicUrl).origin;
  } catch {
    return false;
  }
}

function csrfAllowed(req, session, config) {
  const header = Array.isArray(req.headers['x-csrf-token'])
    ? req.headers['x-csrf-token'][0]
    : req.headers['x-csrf-token'];
  return validOrigin(req, config) && constantTimeStringEqual(header, session.csrf);
}

async function handleLogin(res, config) {
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const flow = signedValue(JSON.stringify({ state, verifier, expiresAt: Date.now() + 10 * 60 * 1000 }), config.sessionSecret);
  const target = new URL('https://github.com/login/oauth/authorize');
  target.searchParams.set('client_id', config.clientId);
  target.searchParams.set('redirect_uri', `${config.publicUrl}/oauth/callback`);
  target.searchParams.set('state', state);
  target.searchParams.set('code_challenge', challenge);
  target.searchParams.set('code_challenge_method', 'S256');
  redirect(res, target.toString(), [cookie('second_opinion_oauth', flow, config, '; Max-Age=600')]);
}

async function handleOAuthCallback(req, res, url, store, config) {
  const rawFlow = readSignedValue(parseCookies(req).second_opinion_oauth, config.sessionSecret);
  let flow;
  try {
    flow = JSON.parse(rawFlow);
  } catch {
    return sendJson(res, 400, { error: 'OAuth flow cookie is invalid' });
  }
  if (!flow || flow.expiresAt <= Date.now()
    || !constantTimeStringEqual(url.searchParams.get('state'), flow.state)) {
    return sendJson(res, 400, { error: 'OAuth state is invalid or expired' });
  }
  const code = url.searchParams.get('code');
  if (!code) return sendJson(res, 400, { error: 'OAuth code is missing' });

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: `${config.publicUrl}/oauth/callback`,
      code_verifier: flow.verifier,
    }),
  });
  const token = await response.json();
  if (!response.ok || !token.access_token) {
    return sendJson(res, 502, { error: 'GitHub OAuth exchange failed' });
  }
  const user = await githubRequest('/user', { token: token.access_token });
  const session = await createSession(store, config, user, token.access_token);
  redirect(res, '/dashboard', [
    cookie('second_opinion_session', session.id, config, `; Max-Age=${SESSION_TTL_MS / 1000}`),
    cookie('second_opinion_oauth', '', config, '; Max-Age=0'),
  ]);
}

async function handleInstallationsApi(req, res, session, store, config) {
  const githubInstallations = await listUserInstallations(session.accessToken);
  const local = await store.read((state) => structuredClone(state.installations));
  const usage = await store.read((state) => structuredClone(state.usage));
  const installations = githubInstallations.map((installation) => {
    const settings = local[String(installation.id)];
    if (!settings || settings.managerId !== session.user.id) return null;
    return {
      id: installation.id,
      account: installation.account?.login,
      repositorySelection: installation.repository_selection,
      settings,
      reviewsUsed: usage[`${installation.id}:${monthKey()}`] || 0,
      reviewLimit: config.monthlyReviewLimit,
    };
  }).filter(Boolean);
  sendJson(res, 200, {
    user: session.user,
    installations,
    models: config.models,
    installUrl: `https://github.com/apps/${config.appSlug}/installations/new`,
  });
}

async function authorizedInstallation(res, session, installationId) {
  const installations = await listUserInstallations(session.accessToken);
  const installation = installations.find((candidate) => String(candidate.id) === installationId);
  if (!installation) {
    sendJson(res, 403, { error: 'installation is not accessible to this GitHub user' });
    return null;
  }
  if (installation.account?.type === 'User' && installation.account.id !== session.user.id) {
    sendJson(res, 403, { error: 'only the installation owner can manage settings' });
    return null;
  }
  return installation;
}

async function isInstallationManager(store, installationId, userId) {
  return store.read((state) => state.installations[installationId]?.managerId === userId);
}

async function handleInstallationUpdate(req, res, session, store, config, installationId, cancel) {
  if (!csrfAllowed(req, session, config)) return sendJson(res, 403, { error: 'CSRF check failed' });
  const githubInstallation = await authorizedInstallation(res, session, installationId);
  if (!githubInstallation) return;
  if (!await isInstallationManager(store, installationId, session.user.id)) {
    return sendJson(res, 403, { error: 'only the user who installed the App can manage settings' });
  }

  let payload;
  try {
    payload = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
  } catch (error) {
    return sendJson(res, error.statusCode || 400, { error: 'invalid JSON body' });
  }
  const provider = nonEmpty(payload.provider);
  const model = nonEmpty(payload.model);
  if (!provider || !config.models[provider]?.includes(model)) {
    return sendJson(res, 400, { error: 'provider and model must match an offered model' });
  }
  if (payload.enabled !== true) cancel(installationId);

  const settings = await store.update((state) => {
    const installation = state.installations[installationId];
    installation.enabled = payload.enabled === true;
    installation.provider = provider;
    installation.model = model;
    installation.updatedAt = Date.now();
    if (!installation.enabled) cancelInstallationJobs(state, installationId);
    return installation;
  });
  sendJson(res, 200, { settings });
}

async function handleInstallationDelete(req, res, session, store, config, installationId, cancel) {
  if (!csrfAllowed(req, session, config)) return sendJson(res, 403, { error: 'CSRF check failed' });
  if (!await authorizedInstallation(res, session, installationId)) return;
  if (!await isInstallationManager(store, installationId, session.user.id)) {
    return sendJson(res, 403, { error: 'only the user who installed the App can delete service data' });
  }
  cancel(installationId);
  await deleteInstallation(store, installationId);
  sendJson(res, 200, {
    deleted: true,
    uninstallUrl: 'https://github.com/settings/installations',
  });
}

async function handleWebhook(req, res, store, config, reviewQueue, rateLimiter) {
  let rawBody;
  try {
    rawBody = await readBody(req);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, { error: error.message });
  }
  if (!verifyWebhookSignature(config.webhookSecret, rawBody, req.headers['x-hub-signature-256'])) {
    return sendJson(res, 401, { error: 'invalid webhook signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'invalid webhook JSON' });
  }
  const event = req.headers['x-github-event'];
  let freshDelivery;
  try {
    freshDelivery = await reserveDelivery(store, req.headers['x-github-delivery']);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, { error: error.message });
  }
  if (!freshDelivery) {
    return sendJson(res, 202, { accepted: false, reason: 'duplicate_delivery' });
  }
  if (event === 'ping') return sendJson(res, 200, { accepted: true });
  if (event === 'github_app_authorization') {
    if (payload.action === 'revoked' && payload.sender?.id) {
      await deleteUserSessions(store, payload.sender.id);
    }
    return sendJson(res, 202, { accepted: true });
  }
  const installationId = payload.installation?.id;
  if (!installationId) return sendJson(res, 400, { error: 'installation id is missing' });

  if (event === 'installation') {
    if (payload.action === 'deleted') {
      reviewQueue.cancel(installationId);
      await deleteInstallation(store, installationId);
    } else {
      if (payload.action === 'suspend') reviewQueue.cancel(installationId);
      const suspended = payload.action === 'suspend'
        ? true
        : payload.action === 'unsuspend' ? false : undefined;
      const lifecycleAt = Date.parse(payload.installation?.updated_at || '') || Date.now();
      await upsertInstallation(
        store,
        installationId,
        payload.installation?.account?.login,
        payload.sender?.id,
        config,
        suspended,
        lifecycleAt,
      );
    }
    return sendJson(res, 202, { accepted: true });
  }
  if (event !== 'pull_request' || !REVIEW_ACTIONS.has(payload.action) || payload.pull_request?.draft) {
    return sendJson(res, 202, { accepted: false, reason: 'event_ignored' });
  }
  if (!rateLimiter.accept(String(installationId))) {
    return sendJson(res, 429, { error: 'installation rate limit exceeded' });
  }

  const repository = payload.repository?.full_name;
  const repositoryId = payload.repository?.id;
  const pullNumber = payload.pull_request?.number;
  const headSha = payload.pull_request?.head?.sha;
  if (!repository || !repositoryId || !pullNumber || !headSha) {
    return sendJson(res, 400, { error: 'pull request payload is incomplete' });
  }
  const job = { installationId, repository, repositoryId, pullNumber, headSha };
  const reservation = await reserveReview(store, job, config.monthlyReviewLimit);
  if (reservation.accepted) {
    if (!reviewQueue.enqueue({ job, jobKey: reservation.jobKey })) {
      await setJobStatus(store, reservation.jobKey, 'failed');
      return sendJson(res, 503, { error: 'review queue is full' });
    }
  }
  sendJson(res, 202, { accepted: reservation.accepted, reason: reservation.reason });
}

export function createRateLimiter(limit, now = () => Date.now()) {
  const windows = new Map();
  return {
    accept(key) {
      const timestamp = now();
      const current = windows.get(key);
      if (!current || timestamp - current.startedAt >= 60_000) {
        windows.set(key, { startedAt: timestamp, count: 1 });
        return true;
      }
      if (current.count >= limit) return false;
      current.count += 1;
      return true;
    },
  };
}

export function createServer(config, store) {
  const reviewQueue = createReviewQueue(config, store);
  const rateLimiter = createRateLimiter(config.rateLimitPerMinute);
  store.read((state) => Object.entries(state.jobs)
    .filter(([, job]) => job.status === 'queued' && job.job)
    .map(([jobKey, record]) => ({
      job: record.job,
      jobKey,
    })))
    .then(async (jobs) => {
      for (const job of jobs) {
        if (!reviewQueue.enqueue(job)) await setJobStatus(store, job.jobKey, 'failed');
      }
    })
    .catch((error) => console.error(`could not recover queued reviews: ${error.message}`));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', config.publicUrl);
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/github/webhooks') {
        return await handleWebhook(req, res, store, config, reviewQueue, rateLimiter);
      }
      if (req.method === 'GET' && url.pathname === '/login') {
        return await handleLogin(res, config);
      }
      if (req.method === 'GET' && url.pathname === '/oauth/callback') {
        return await handleOAuthCallback(req, res, url, store, config);
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/setup')) {
        return redirect(res, '/dashboard');
      }

      const session = await currentSession(req, store, config);
      if (!session) return redirect(res, '/login');
      if (req.method === 'POST' && url.pathname === '/logout') {
        if (!csrfAllowed(req, session, config)) {
          return sendJson(res, 403, { error: 'CSRF check failed' });
        }
        await store.update((state) => { delete state.sessions[session.sessionKey]; });
        return redirect(res, '/login', [
          cookie('second_opinion_session', '', config, '; Max-Age=0'),
        ]);
      }
      if (req.method === 'GET' && url.pathname === '/dashboard') {
        const template = await fs.readFile(new URL('./dashboard.html', import.meta.url), 'utf8');
        const body = template.replace('{{CSRF_TOKEN}}', session.csrf);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        });
        return res.end(body);
      }
      if (req.method === 'GET' && ['/dashboard.css', '/dashboard.js'].includes(url.pathname)) {
        const extension = url.pathname.endsWith('.css') ? 'css' : 'js';
        const body = await fs.readFile(new URL(`.${url.pathname}`, import.meta.url));
        res.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': extension === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
          'x-content-type-options': 'nosniff',
        });
        return res.end(body);
      }
      if (req.method === 'GET' && url.pathname === '/api/installations') {
        return await handleInstallationsApi(req, res, session, store, config);
      }
      const match = url.pathname.match(/^\/api\/installations\/(\d+)$/);
      if (match && req.method === 'PUT') {
        return await handleInstallationUpdate(
          req,
          res,
          session,
          store,
          config,
          match[1],
          reviewQueue.cancel,
        );
      }
      if (match && req.method === 'DELETE') {
        return await handleInstallationDelete(
          req,
          res,
          session,
          store,
          config,
          match[1],
          reviewQueue.cancel,
        );
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      console.error(`request failed: ${error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal server error' });
      else res.end();
    }
  });
  const maintenance = setInterval(() => {
    store.update(() => {}).catch((error) => {
      console.error(`hosted state maintenance failed: ${error.message}`);
    });
  }, MAINTENANCE_INTERVAL_MS);
  maintenance.unref();
  server.once('close', () => clearInterval(maintenance));
  server.shutdownWorkers = () => reviewQueue.shutdown();
  return server;
}

async function main() {
  const config = loadConfig();
  const store = new JsonStore(config.statePath);
  await store.init();
  const server = createServer(config, store);
  let shutdownStarted = false;
  const shutdown = async (signal) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    console.log(`hosted service shutdown started (${signal})`);
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections?.();
    await server.shutdownWorkers();
    await closed;
    console.log('hosted service shutdown completed');
  };
  process.once('SIGINT', () => shutdown('SIGINT').catch((error) => {
    console.error(`hosted service shutdown failed: ${error.message}`);
    process.exitCode = 1;
  }));
  process.once('SIGTERM', () => shutdown('SIGTERM').catch((error) => {
    console.error(`hosted service shutdown failed: ${error.message}`);
    process.exitCode = 1;
  }));
  server.listen(config.port, config.host, () => {
    console.log(`second-opinion hosted service listening on ${config.host}:${config.port}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
