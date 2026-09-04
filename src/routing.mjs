// Pure routing decisions. No I/O here.

import { isStale } from './health.mjs';

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

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

/** Strip hop-by-hop headers and set the origin Host. Returns a new Headers. */
export function upstreamHeaders(requestHeaders, origin, clientIp) {
  const h = new Headers(requestHeaders);
  for (const k of HOP_BY_HOP) if (k !== 'upgrade' && k !== 'connection') h.delete(k);
  h.set('Host', origin.hostHeader);
  h.set('X-Forwarded-Host', requestHeaders.get('host') ?? origin.hostHeader);
  h.set('X-Forwarded-Proto', 'https');
  if (clientIp) h.set('X-Forwarded-For', clientIp);
  return h;
}

/** Access gate: returns a Response to short-circuit with, or null to continue. */
export function accessGate(host, requestHeaders) {
  if (host.access === 'public') return null;
  if (host.access === 'deny') return new Response('Not Found', { status: 404 });
  // cloudflare-access: Cloudflare Access injects this header only after a
  // successful policy evaluation; a Worker on a route behind Access never sees
  // unauthenticated traffic, so absence means Access is not enforced yet.
  const email = requestHeaders.get('cf-access-authenticated-user-email');
  const jwt = requestHeaders.get('cf-access-jwt-assertion');
  if (email || jwt) return null;
  return new Response('Forbidden: Cloudflare Access required', { status: 403 });
}

/** Headers we add to every proxied response for observability. */
export function decorateResponseHeaders(headers, decision, origin) {
  const h = new Headers(headers);
  h.set('x-ores-origin', origin.kind);
  h.set('x-ores-route', decision.reason);
  h.set('x-ores-router', 'ores-edge-router');
  return h;
}
