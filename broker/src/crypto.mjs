import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const MAX_AUTH_BYTES = 1024 * 1024;

function associatedData(credentialId, keyVersion) {
  return Buffer.from(`second-opinion:credential:${credentialId}:key:${keyVersion}`, 'utf8');
}

export function validateAuthJson(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.length === 0 || bytes.length > MAX_AUTH_BYTES) {
    throw new Error('Codex auth file has an invalid size');
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Codex auth file is not valid JSON');
  }
  const refreshToken = parsed?.tokens?.refresh_token;
  if (parsed?.auth_mode !== 'chatgpt' || typeof refreshToken !== 'string' || !refreshToken) {
    throw new Error('Codex auth file must use ChatGPT auth and contain a refresh token');
  }
  return bytes;
}

export function encryptAuthJson(value, keyring, credentialId, version = keyring.activeVersion) {
  const plaintext = validateAuthJson(value);
  const key = keyring.keys.get(version);
  if (!key) throw new Error(`master key version ${version} is unavailable`);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(associatedData(credentialId, version));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    keyVersion: version,
    nonce: nonce.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptAuthJson(record, keyring, credentialId) {
  const version = Number(record.key_version ?? record.keyVersion);
  const key = keyring.keys.get(version);
  if (!key) throw new Error(`master key version ${version} is unavailable`);
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(record.nonce, 'base64'),
    );
    decipher.setAAD(associatedData(credentialId, version));
    decipher.setAuthTag(Buffer.from(record.auth_tag ?? record.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return validateAuthJson(plaintext);
  } catch (error) {
    if (error?.message?.startsWith('master key version')) throw error;
    throw new Error('stored Codex credential could not be decrypted');
  }
}
