import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeClaims, bearerToken } from '../src/oidc.mjs';
import { InputError } from '../src/validation.mjs';

function registration(overrides = {}) {
  return {
    repository: 'owner/repo',
    repository_id: 12345,
    credential_id: 'a5b7d4de-0000-4000-8000-000000000000',
    workflow_ref: 'owner/repo/.github/workflows/review.yml@refs/heads/main',
    job_workflow_ref: null,
    trusted_ref: 'refs/heads/main',
    event_name: 'pull_request_target',
    enabled: true,
    ...overrides,
  };
}

function claims(overrides = {}) {
  return {
    repository: 'owner/repo',
    repository_id: '12345',
    workflow_ref: 'owner/repo/.github/workflows/review.yml@refs/heads/main',
    event_name: 'pull_request_target',
    ref: 'refs/heads/main',
    jti: 'token-id-1',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

test('parses a well-formed bearer token', () => {
  assert.equal(bearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(bearerToken('bearer token123  '), 'token123');
  assert.throws(() => bearerToken(undefined), InputError);
  assert.throws(() => bearerToken('Basic abc'), InputError);
  assert.throws(() => bearerToken('Bearer'), InputError);
  assert.throws(() => bearerToken('Bearer a b'), InputError);
});

test('authorizes exact identity matches', () => {
  assert.equal(authorizeClaims(claims(), registration(), 'owner/repo'), true);
});

test('rejects unknown or disabled repositories', () => {
  assert.throws(() => authorizeClaims(claims(), null, 'owner/repo'), /not enrolled/);
  assert.throws(
    () => authorizeClaims(claims(), registration({ enabled: false }), 'owner/repo'),
    /not enrolled/,
  );
});

test('rejects mismatched workflow identity claims', () => {
  const forbidden = (error) => error instanceof InputError && error.statusCode === 403;
  assert.throws(
    () => authorizeClaims(claims({ workflow_ref: 'owner/repo/.github/workflows/other.yml@refs/heads/main' }), registration(), 'owner/repo'),
    forbidden,
  );
  assert.throws(
    () => authorizeClaims(claims({ event_name: 'pull_request' }), registration(), 'owner/repo'),
    forbidden,
  );
  assert.throws(
    () => authorizeClaims(claims({ ref: 'refs/heads/feature' }), registration(), 'owner/repo'),
    forbidden,
  );
  assert.throws(
    () => authorizeClaims(claims({ repository_id: '99999' }), registration(), 'owner/repo'),
    forbidden,
  );
  assert.throws(
    () => authorizeClaims(claims({ repository: 'owner/other' }), registration(), 'owner/other'),
    forbidden,
  );
});

test('rejects a payload repository that differs from the token identity', () => {
  assert.throws(
    () => authorizeClaims(claims(), registration(), 'owner/other'),
    /does not match OIDC identity/,
  );
});

test('enforces job_workflow_ref only when registered', () => {
  const reg = registration({ job_workflow_ref: 'owner/repo/.github/workflows/review.yml@refs/heads/main' });
  assert.equal(authorizeClaims(claims({ job_workflow_ref: reg.job_workflow_ref }), reg, 'owner/repo'), true);
  assert.throws(() => authorizeClaims(claims(), reg, 'owner/repo'), InputError);
});

test('skips repository_id verification when not registered', () => {
  const reg = registration({ repository_id: null });
  assert.equal(authorizeClaims(claims({ repository_id: 'anything' }), reg, 'owner/repo'), true);
});
