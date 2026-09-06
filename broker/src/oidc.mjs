import { createRemoteJWKSet, jwtVerify } from 'jose';
import { InputError, validateRepository } from './validation.mjs';

let cachedJwks;
let cachedUrl;

function remoteJwks(url) {
  if (!cachedJwks || cachedUrl !== url) {
    cachedUrl = url;
    cachedJwks = createRemoteJWKSet(new URL(url), {
      timeoutDuration: 10_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60 * 1000,
    });
  }
  return cachedJwks;
}

export function bearerToken(header) {
  if (typeof header !== 'string') throw new InputError('missing bearer token', 401, 'unauthorized');
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  if (!match) throw new InputError('invalid bearer token', 401, 'unauthorized');
  return match[1];
}

export async function verifyGithubOidc(token, config) {
  try {
    const { payload } = await jwtVerify(token, remoteJwks(config.oidcJwksUrl), {
      issuer: config.oidcIssuer,
      audience: config.oidcAudience,
      algorithms: ['RS256'],
      clockTolerance: 5,
      requiredClaims: ['exp', 'iat', 'jti', 'repository', 'repository_id', 'workflow_ref', 'event_name', 'ref'],
    });
    for (const name of ['jti', 'repository', 'repository_id', 'workflow_ref', 'event_name', 'ref']) {
      if (typeof payload[name] !== 'string' || !payload[name]) {
        throw new Error(`invalid ${name} claim`);
      }
    }
    validateRepository(payload.repository);
    return payload;
  } catch {
    throw new InputError('OIDC token verification failed', 401, 'unauthorized');
  }
}

function exactClaim(claims, name, expected) {
  if (typeof expected !== 'string' || !expected || String(claims[name] ?? '') !== expected) {
    throw new InputError('workflow identity is not authorized', 403, 'forbidden');
  }
}

export function authorizeClaims(claims, registration, payloadRepository) {
  if (!claims || !registration || registration.enabled !== true) {
    throw new InputError('repository is not enrolled', 403, 'forbidden');
  }
  exactClaim(claims, 'repository', registration.repository);
  if (payloadRepository !== undefined && payloadRepository !== registration.repository) {
    throw new InputError('request repository does not match OIDC identity', 403, 'forbidden');
  }
  if (registration.repository_id === null || registration.repository_id === undefined) {
    throw new InputError('workflow identity is not authorized', 403, 'forbidden');
  }
  exactClaim(claims, 'repository_id', String(registration.repository_id));
  exactClaim(claims, 'workflow_ref', registration.workflow_ref);
  exactClaim(claims, 'event_name', registration.event_name);
  exactClaim(claims, 'ref', registration.trusted_ref);
  if (registration.job_workflow_ref) {
    exactClaim(claims, 'job_workflow_ref', registration.job_workflow_ref);
  }
  return true;
}
