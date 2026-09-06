import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.mjs';
import { testConfig } from '../test-support/helpers.mjs';

test('loads a minimal valid configuration', () => {
  const config = testConfig();
  assert.equal(config.port, 3000);
  assert.equal(config.oidcAudience, 'https://broker.example/reviews');
  assert.equal(config.oidcIssuer, 'https://token.actions.githubusercontent.com');
  assert.equal(config.keyring.activeVersion, 1);
  assert.equal(config.keyring.keys.size, 1);
  assert.ok(config.allowedModels.has('gpt-5.6-sol'));
  assert.equal(config.defaultModel, 'gpt-5.6-sol');
});

test('requires database URL, audience, and a master key', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL is required/);
  assert.throws(
    () => loadConfig({ DATABASE_URL: 'postgres://x', BROKER_OIDC_AUDIENCE: 'a' }),
    /BROKER_MASTER_KEY is required/,
  );
});

test('rejects malformed master keys', () => {
  assert.throws(() => testConfig({ BROKER_MASTER_KEY: 'not-base64!!' }), /32 base64/);
  const shortKey = randomBytes(16).toString('base64');
  assert.throws(() => testConfig({ BROKER_MASTER_KEY: shortKey }), /32 base64/);
});

test('parses a versioned keyring and defaults active version to the highest', () => {
  const keyOne = randomBytes(32).toString('base64');
  const keyTwo = randomBytes(32).toString('base64');
  const config = testConfig({
    BROKER_MASTER_KEY: undefined,
    BROKER_MASTER_KEYS: JSON.stringify({ 1: keyOne, 2: keyTwo }),
  });
  assert.equal(config.keyring.keys.size, 2);
  assert.equal(config.keyring.activeVersion, 2);
});

test('rejects an active version missing from the keyring', () => {
  const keyOne = randomBytes(32).toString('base64');
  assert.throws(
    () =>
      testConfig({
        BROKER_MASTER_KEY: undefined,
        BROKER_MASTER_KEYS: JSON.stringify({ 1: keyOne }),
        BROKER_ACTIVE_KEY_VERSION: '2',
      }),
    /not present in the configured keyring/,
  );
});

test('requires the default model to be allowed', () => {
  assert.throws(
    () => testConfig({ BROKER_DEFAULT_MODEL: 'gpt-other' }),
    /must be in BROKER_ALLOWED_MODELS/,
  );
  const config = testConfig({
    BROKER_ALLOWED_MODELS: 'gpt-a, gpt-b, gpt-a',
    BROKER_DEFAULT_MODEL: 'gpt-b',
  });
  assert.deepEqual([...config.allowedModels], ['gpt-a', 'gpt-b']);
  assert.equal(config.defaultModel, 'gpt-b');
});

test('validates integer bounds', () => {
  assert.throws(() => testConfig({ PORT: '0' }), /PORT must be an integer/);
  assert.throws(() => testConfig({ BROKER_MAX_CONCURRENCY: 'nope' }), /BROKER_MAX_CONCURRENCY/);
});
