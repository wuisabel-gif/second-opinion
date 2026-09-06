import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { verifyGithubOidc } from '../src/oidc.mjs';
import { InputError } from '../src/validation.mjs';

async function fixture(t) {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.use = 'sig';
  jwk.alg = 'RS256';
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = {
    oidcIssuer: 'https://token.actions.githubusercontent.com',
    oidcAudience: 'second-opinion-test',
    oidcJwksUrl: `http://127.0.0.1:${server.address().port}/jwks`,
  };
  const baseClaims = {
    jti: 'unique-token-id',
    repository: 'owner/repo',
    repository_id: '12345',
    workflow_ref: 'owner/repo/.github/workflows/review.yml@refs/heads/main',
    event_name: 'pull_request_target',
    ref: 'refs/heads/main',
  };
  async function token(overrides = {}, audience = config.oidcAudience) {
    return new SignJWT({ ...baseClaims, ...overrides })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(config.oidcIssuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }
  return { config, token };
}

test('verifies a fully valid GitHub-style OIDC token against JWKS', async (t) => {
  const { config, token } = await fixture(t);
  const claims = await verifyGithubOidc(await token(), config);
  assert.equal(claims.repository, 'owner/repo');
  assert.equal(claims.repository_id, '12345');
  assert.equal(claims.jti, 'unique-token-id');
});

test('rejects wrong audience and malformed required claims', async (t) => {
  const { config, token } = await fixture(t);
  await assert.rejects(
    verifyGithubOidc(await token({}, 'wrong-audience'), config),
    (error) => error instanceof InputError && error.statusCode === 401,
  );
  await assert.rejects(
    verifyGithubOidc(await token({ jti: undefined }), config),
    (error) => error instanceof InputError && error.statusCode === 401,
  );
  await assert.rejects(
    verifyGithubOidc(await token({ repository: '../invalid' }), config),
    (error) => error instanceof InputError && error.statusCode === 401,
  );
});
