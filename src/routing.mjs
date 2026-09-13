// Pure routing decisions except the Access verification gate, which delegates
// signature verification to src/access.mjs.

import { verifyCloudflareAccess } from './access.mjs';
import { isStale } from './health.mjs';

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const RESERVED_EXACT = new Set([
  'host',
  'forwarded',
  'x-real-ip',
  'cf-access-authenticated-user-email',
  'cf-access-jwt-assertion',
]);
const RESERVED_PREFIXES = ['x-forwarded-', 'x-ores-'];

/** Find the host entry for an incoming hostname, or null. */
export function matchHost(config, hostname) {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (!h.endsWith(`.${config.domain}`)) return h === config.domain ? config.hosts['@'] ?? null : null;
  const label = h.slice(0, -(config.domain.length + 1));
  return config.hosts[label] ?? null;
}

/**
 * Decide which origin serves this request.
 * @returns {{ origin: object, reason: string, primaryUp: boolean|null }}
 */
export function chooseOrigin(host, state, now) {
  if (!host.fallback) return { origin: host.primary, reason: 'no-fallback', primaryUp: state?.up ?? null };
  if (isStale(state, host.health, now)) return { origin: host.primary, reason: 'health-unknown', primaryUp: null };
  if (state.up) return { origin: host.primary, reason: 'primary-healthy', primaryUp: true };
  return { origin: host.fallback, reason: 'primary-down', primaryUp: false };
}

/** Should a failed primary response be retried against the fallback? */
export function shouldRetryOnFallback(host, method, status, hadNetworkError) {
  if (!host.fallback || !host.retryOnPrimaryError) return false;
  if (!IDEMPOTENT.has(method.toUpperCase())) return false;
  return hadNetworkError || status === 502 || status === 503 || status === 504 || status === 521 || status === 522 || status === 523;
}

/** Build the upstream URL for a request at a given origin. */
export function upstreamUrl(origin, requestUrl) {
  const u = new URL(requestUrl);
  const base = new URL(origin.url);
  base.pathname = `${origin.pathPrefix}${u.pathname}`;
  base.search = u.search;
  return base;
}

function connectionTokens(headers) {
  const value = headers.get('connection');
  if (!value) return new Set();
  return new Set(
    value
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isReservedRequestHeader(name, dynamicHopByHop) {
  const lower = name.toLowerCase();
  return HOP_BY_HOP.has(lower)
    || dynamicHopByHop.has(lower)
    || RESERVED_EXACT.has(lower)
    || RESERVED_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function stripCloudflareAuthorizationCookie(value) {
  if (!value) return null;
  const kept = value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => part.split('=', 1)[0].toLowerCase() !== 'cf_authorization');
  return kept.length > 0 ? kept.join('; ') : null;
}

/**
 * Build trusted upstream request headers from an untrusted incoming request.
 *
 * This intentionally does not clone headers wholesale. Hop-by-hop headers,
 * Connection-nominated headers, forwarding metadata, ORES routing metadata and
 * Cloudflare Access identity material are removed before trusted values are
 * reconstructed. WebSocket Upgrade/Connection are re-added only for an
 * explicitly admitted websocket request.
 */
export function upstreamHeaders(
  requestHeaders,
  origin,
  clientIp,
  publicHost,
  { websocket = false } = {},
) {
  const dynamicHopByHop = connectionTokens(requestHeaders);
  const h = new Headers();

  for (const [name, value] of requestHeaders.entries()) {
    if (isReservedRequestHeader(name, dynamicHopByHop)) continue;
    if (name.toLowerCase() === 'cookie') {
      const sanitized = stripCloudflareAuthorizationCookie(value);
      if (sanitized) h.set(name, sanitized);
      continue;
    }
    h.append(name, value);
  }

  h.set('Host', origin.hostHeader);
  h.set('X-Forwarded-Host', publicHost ?? origin.hostHeader);
  h.set('X-Forwarded-Proto', 'https');
  if (clientIp) h.set('X-Forwarded-For', clientIp);

  if (websocket) {
    h.set('Connection', 'Upgrade');
    h.set('Upgrade', 'websocket');
  }
  return h;
}

/**
 * Access gate: returns a Response to short-circuit with, or null to continue.
 * Protected routes cryptographically verify the Access JWT; presence of an
 * Access-looking email/JWT header is never considered authentication.
 */
export async function accessGate(host, requestHeaders, env, verifyImpl) {
  if (host.access === 'public') return null;
  if (host.access === 'deny') return new Response('Not Found', { status: 404 });

  const verified = await verifyCloudflareAccess(host, requestHeaders, env, verifyImpl);
  if (verified.ok) return null;
  const body = verified.status === 503 ? 'Access verifier unavailable' : 'Forbidden';
  return new Response(body, {
    status: verified.status,
    headers: { 'cache-control': 'no-store' },
  });
}

/** Headers we add to every proxied response for observability. */
export function decorateResponseHeaders(headers, decision, origin) {
  const h = new Headers(headers);
  h.set('x-ores-origin', origin.kind);
  h.set('x-ores-route', decision.reason);
  h.set('x-ores-router', 'ores-edge-router');
  return h;
}

export const __test = Object.freeze({
  connectionTokens,
  isReservedRequestHeader,
  stripCloudflareAuthorizationCookie,
});
