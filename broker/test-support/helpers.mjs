import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.mjs';

const MASTER_KEY = randomBytes(32).toString('base64');

export function testEnv(overrides = {}) {
  return {
    DATABASE_URL: 'postgres://broker:test@localhost:5432/broker_test',
    BROKER_OIDC_AUDIENCE: 'https://broker.example/reviews',
    BROKER_MASTER_KEY: MASTER_KEY,
    ...overrides,
  };
}

export function testConfig(overrides = {}) {
  return loadConfig(testEnv(overrides));
}

export function sampleAuthJson(refreshToken = 'refresh-token-1') {
  return Buffer.from(
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'access',
        id_token: 'id',
        refresh_token: refreshToken,
      },
    }),
  );
}
