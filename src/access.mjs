import { createRemoteJWKSet, jwtVerify } from 'jose';

const MAX_ACCESS_TOKEN_BYTES = 16 * 1024;
const jwksByIssuer = new Map();
let cachedAudienceSource = null;
let cachedAudiences = Object.freeze({});

function normalizeTeamDomain(value) {
  if (typeof value !== 'string' || !value) throw new Error('CF_ACCESS_TEAM_DOMAIN is required');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('CF_ACCESS_TEAM_DOMAIN must be an https origin');
  }
  if (!url.hostname.endsWith('.cloudflareaccess.com')) {
    throw new Error('CF_ACCESS_TEAM_DOMAIN must be a cloudflareaccess.com origin');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('CF_ACCESS_TEAM_DOMAIN must not contain a path');
  }
  return url.origin;
}

function parseAudienceMap(source) {
  if (!source) return Object.freeze({});
  if (source === cachedAudienceSource) return cachedAudiences;
  const parsed = JSON.parse(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CF_ACCESS_AUDIENCES must be a JSON object');
  }
  const normalized = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || !value) throw new Error(`invalid Access audience for ${key}`);
    normalized[key.toLowerCase()] = value;
  }
  cachedAudienceSource = source;
  cachedAudiences = Object.freeze(normalized);
  return cachedAudiences;
}

function audienceFor(host, env) {
  const audiences = parseAudienceMap(env.CF_ACCESS_AUDIENCES);
  const label = String(host.label ?? '').toLowerCase();
  const publicHost = String(host.publicHost ?? '').toLowerCase();
  return audiences[publicHost] ?? audiences[label] ?? env.CF_ACCESS_AUD ?? null;
}

function remoteJwks(issuer) {
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, jwks);
  }
  return jwks;
}

/**
 * Verify the Cloudflare Access assertion for a protected route.
 * Returns the verified JWT payload and never trusts the user-email header by
 * itself. `verifyImpl` exists so unit tests can avoid network/JWKS I/O.
 */
export async function verifyCloudflareAccess(host, requestHeaders, env, verifyImpl = jwtVerify) {
  const token = requestHeaders.get('cf-access-jwt-assertion');
  if (!token) return { ok: false, status: 403, reason: 'missing-access-jwt' };
  if (token.length > MAX_ACCESS_TOKEN_BYTES) {
    return { ok: false, status: 403, reason: 'oversized-access-jwt' };
  }

  let issuer;
  let audience;
  try {
    issuer = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
    audience = audienceFor(host, env);
    if (!audience) throw new Error('Access audience is required');
  } catch {
    // A protected route without verifier configuration is an operator error,
    // not a reason to downgrade to header-presence authentication.
    return { ok: false, status: 503, reason: 'access-verifier-misconfigured' };
  }

  try {
    const key = remoteJwks(issuer);
    const result = await verifyImpl(token, key, {
      issuer,
      audience,
      algorithms: ['RS256'],
      clockTolerance: 5,
    });
    return { ok: true, status: 200, reason: 'verified', payload: result.payload };
  } catch {
    return { ok: false, status: 403, reason: 'invalid-access-jwt' };
  }
}

export const __test = Object.freeze({ normalizeTeamDomain, parseAudienceMap, audienceFor });
