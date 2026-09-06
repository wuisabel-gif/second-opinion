import process from 'node:process';

function required(name, env = process.env) {
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}, env = process.env) {
  const raw = env[name]?.trim() || String(fallback);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseKeyring(env = process.env) {
  const keys = new Map();
  const encoded = env.BROKER_MASTER_KEYS?.trim();
  if (encoded) {
    let parsed;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      throw new Error('BROKER_MASTER_KEYS must be a JSON object');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('BROKER_MASTER_KEYS must be a JSON object');
    }
    for (const [rawVersion, rawKey] of Object.entries(parsed)) {
      const version = Number(rawVersion);
      if (!Number.isSafeInteger(version) || version < 1 || typeof rawKey !== 'string') {
        throw new Error('BROKER_MASTER_KEYS contains an invalid version or key');
      }
      const key = Buffer.from(rawKey, 'base64');
      if (key.length !== 32 || key.toString('base64') !== rawKey.replace(/\s+/g, '')) {
        throw new Error(`BROKER_MASTER_KEYS version ${version} must be exactly 32 base64-encoded bytes`);
      }
      keys.set(version, key);
    }
  } else {
    const rawKey = required('BROKER_MASTER_KEY', env);
    const version = integer('BROKER_MASTER_KEY_VERSION', 1, { min: 1 }, env);
    const key = Buffer.from(rawKey, 'base64');
    if (key.length !== 32 || key.toString('base64') !== rawKey.replace(/\s+/g, '')) {
      throw new Error('BROKER_MASTER_KEY must be exactly 32 base64-encoded bytes');
    }
    keys.set(version, key);
  }
  if (keys.size === 0) throw new Error('at least one broker master key is required');
  const activeVersion = integer(
    'BROKER_ACTIVE_KEY_VERSION',
    Math.max(...keys.keys()),
    { min: 1 },
    env,
  );
  if (!keys.has(activeVersion)) {
    throw new Error('BROKER_ACTIVE_KEY_VERSION is not present in the configured keyring');
  }
  return { keys, activeVersion };
}

function csv(name, fallback, env = process.env) {
  const values = (env[name]?.trim() || fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error(`${name} must contain at least one value`);
  return [...new Set(values)];
}

export function loadConfig(env = process.env) {
  const databaseUrl = required('DATABASE_URL', env);
  const oidcAudience = required('BROKER_OIDC_AUDIENCE', env);
  const allowedModels = csv('BROKER_ALLOWED_MODELS', 'gpt-5.6-sol', env);
  const defaultModel = env.BROKER_DEFAULT_MODEL?.trim() || allowedModels[0];
  if (!allowedModels.includes(defaultModel)) {
    throw new Error('BROKER_DEFAULT_MODEL must be in BROKER_ALLOWED_MODELS');
  }
  const keyring = parseKeyring(env);
  return Object.freeze({
    port: integer('PORT', 3000, { min: 1, max: 65535 }, env),
    databaseUrl,
    oidcAudience,
    oidcIssuer: 'https://token.actions.githubusercontent.com',
    oidcJwksUrl: 'https://token.actions.githubusercontent.com/.well-known/jwks',
    keyring,
    allowedModels: new Set(allowedModels),
    defaultModel,
    codexBin: env.CODEX_BIN?.trim() || 'codex',
    maxBodyBytes: integer('BROKER_MAX_BODY_BYTES', 512 * 1024, { min: 1024, max: 5 * 1024 * 1024 }, env),
    maxOutputBytes: integer('BROKER_MAX_OUTPUT_BYTES', 256 * 1024, { min: 1024, max: 1024 * 1024 }, env),
    maxDiffBytes: integer('BROKER_MAX_DIFF_BYTES', 140 * 1024, { min: 1024, max: 1024 * 1024 }, env),
    maxContextBytes: integer('BROKER_MAX_CONTEXT_BYTES', 80 * 1024, { min: 0, max: 1024 * 1024 }, env),
    maxRulesBytes: integer('BROKER_MAX_RULES_BYTES', 24 * 1024, { min: 0, max: 256 * 1024 }, env),
    maxSummaryChars: integer('BROKER_MAX_SUMMARY_CHARS', 8000, { min: 100, max: 50000 }, env),
    maxCommentChars: integer('BROKER_MAX_COMMENT_CHARS', 8000, { min: 100, max: 50000 }, env),
    maxFindings: integer('BROKER_MAX_FINDINGS', 50, { min: 1, max: 200 }, env),
    codexTimeoutMs: integer('BROKER_CODEX_TIMEOUT_MS', 15 * 60 * 1000, { min: 10_000, max: 60 * 60 * 1000 }, env),
    maxConcurrency: integer('BROKER_MAX_CONCURRENCY', 2, { min: 1, max: 32 }, env),
    maxQueue: integer('BROKER_MAX_QUEUE', 20, { min: 0, max: 1000 }, env),
    perRepoHourlyLimit: integer('BROKER_PER_REPO_HOURLY_LIMIT', 20, { min: 1, max: 1000 }, env),
    databasePoolSize: integer('BROKER_DATABASE_POOL_SIZE', 10, { min: 2, max: 100 }, env),
  });
}

export const configInternals = { required, integer, parseKeyring, csv };
