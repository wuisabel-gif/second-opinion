import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  decryptAuthJson,
  encryptAuthJson,
  validateAuthJson,
} from '../src/crypto.mjs';
import { sampleAuthJson, testConfig } from '../test-support/helpers.mjs';

test('accepts a ChatGPT Codex auth file and rejects other shapes', () => {
  assert.ok(validateAuthJson(sampleAuthJson()) instanceof Buffer);
  assert.throws(() => validateAuthJson(Buffer.from('not json')), /not valid JSON/);
  assert.throws(
    () => validateAuthJson(Buffer.from(JSON.stringify({ auth_mode: 'apikey', tokens: { refresh_token: 'x' } }))),
    /ChatGPT auth/,
  );
  assert.throws(
    () => validateAuthJson(Buffer.from(JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }))),
    /refresh token/,
  );
  assert.throws(() => validateAuthJson(Buffer.alloc(0)), /invalid size/);
});

test('encrypts and decrypts with the active key version', () => {
  const config = testConfig();
  const credentialId = randomUUID();
  const auth = sampleAuthJson();
  const encrypted = encryptAuthJson(auth, config.keyring, credentialId);
  assert.equal(encrypted.keyVersion, 1);
  const record = {
    key_version: encrypted.keyVersion,
    nonce: encrypted.nonce,
    auth_tag: encrypted.tag,
    ciphertext: encrypted.ciphertext,
  };
  const decrypted = decryptAuthJson(record, config.keyring, credentialId);
  assert.deepEqual(decrypted, validateAuthJson(auth));
});

test('fails to decrypt for a different credential id (AAD binding)', () => {
  const config = testConfig();
  const auth = sampleAuthJson();
  const encrypted = encryptAuthJson(auth, config.keyring, randomUUID());
  const record = {
    key_version: encrypted.keyVersion,
    nonce: encrypted.nonce,
    auth_tag: encrypted.tag,
    ciphertext: encrypted.ciphertext,
  };
  assert.throws(
    () => decryptAuthJson(record, config.keyring, randomUUID()),
    /could not be decrypted/,
  );
});

test('fails to decrypt tampered ciphertext', () => {
  const config = testConfig();
  const credentialId = randomUUID();
  const encrypted = encryptAuthJson(sampleAuthJson(), config.keyring, credentialId);
  const tampered = Buffer.from(encrypted.ciphertext, 'base64');
  tampered[0] ^= 0xff;
  const record = {
    key_version: encrypted.keyVersion,
    nonce: encrypted.nonce,
    auth_tag: encrypted.tag,
    ciphertext: tampered.toString('base64'),
  };
  assert.throws(() => decryptAuthJson(record, config.keyring, credentialId), /could not be decrypted/);
});

test('decrypts with an older key version while encrypting with the active one', () => {
  const keyOne = randomBytes(32).toString('base64');
  const keyTwo = randomBytes(32).toString('base64');
  const config = testConfig({
    BROKER_MASTER_KEY: undefined,
    BROKER_MASTER_KEYS: JSON.stringify({ 1: keyOne, 2: keyTwo }),
  });
  const credentialId = randomUUID();
  const legacy = encryptAuthJson(sampleAuthJson(), config.keyring, credentialId, 1);
  const record = {
    key_version: legacy.keyVersion,
    nonce: legacy.nonce,
    auth_tag: legacy.tag,
    ciphertext: legacy.ciphertext,
  };
  assert.ok(decryptAuthJson(record, config.keyring, credentialId) instanceof Buffer);
  const rotated = encryptAuthJson(sampleAuthJson(), config.keyring, credentialId);
  assert.equal(rotated.keyVersion, 2);
});

test('rejects decryption when the stored key version is unavailable', () => {
  const config = testConfig();
  const credentialId = randomUUID();
  const encrypted = encryptAuthJson(sampleAuthJson(), config.keyring, credentialId);
  const record = {
    key_version: 99,
    nonce: encrypted.nonce,
    auth_tag: encrypted.tag,
    ciphertext: encrypted.ciphertext,
  };
  assert.throws(() => decryptAuthJson(record, config.keyring, credentialId), /version 99 is unavailable/);
});
