// Cloudflare Worker entry: fetch handler (proxy with failover) + scheduled
// handler (health probes). Config is injected as the ROUTER_CONFIG var
// (JSON string) by the rendered wrangler.toml.

import { normalizeConfig } from './config.mjs';
import { refreshHost, kvKey, INITIAL_STATE } from './health.mjs';
import {
  matchHost,
  chooseOrigin,
  shouldRetryOnFallback,
  upstreamUrl,
  upstreamHeaders,
  accessGate,
  decorateResponseHeaders,
} from './routing.mjs';

let cachedConfig = null;
let cachedConfigSource = null;
const stateCache = new Map(); // key -> { state, at }
const STATE_CACHE_MS = 10_000;

function loadConfig(env) {
  const src = env.ROUTER_CONFIG;
  if (typeof src !== 'string' || !src) throw new Error('ROUTER_CONFIG var is missing; run `npm run render`');
  if (cachedConfig && cachedConfigSource === src) return cachedConfig;
  cachedConfig = normalizeConfig(JSON.parse(src));
  cachedConfigSource = src;
  return cachedConfig;
}

async function readState(env, config, host, now) {
  const key = kvKey(config, host.label);
  const hit = stateCache.get(key);
  if (hit && now - hit.at < STATE_CACHE_MS) return hit.state;
  const state = (await env.HEALTH?.get(key, 'json')) ?? null;
  stateCache.set(key, { state, at: now });
  return state;
}

async function proxy(request, origin, host) {
  if (origin.mode === 'unavailable') {
    return new Response(JSON.stringify({ error: 'origin_unavailable', host: host.publicHost, retryAfter: origin.retryAfter }), {
      status: 503, headers: { 'content-type': 'application/json', 'retry-after': String(origin.retryAfter), 'cache-control': 'no-store' },
    });
  }
  const url = upstreamUrl(origin, request.url);
  if (origin.mode === 'redirect') {
    return Response.redirect(url.toString(), 302);
  }
  const headers = upstreamHeaders(request.headers, origin, request.headers.get('cf-connecting-ip'));
  const init = {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  };
  if (host.websocket && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    return fetch(url.toString(), init); // Workers pass 101 upgrades through unchanged
  }
  return fetch(url.toString(), init);
}

export async function handleFetch(request, env, ctx) {
  const now = Date.now();
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    return new Response(`router misconfigured: ${err.message}`, { status: 500 });
  }
  const url = new URL(request.url);

  // Router's own health, distinct from origin health.
  if (url.pathname === '/__ores/router/healthz') return new Response('ok', { status: 200 });
  if (url.pathname === '/__ores/router/status') {
    const gate = accessGate({ access: config.statusAccess }, request.headers);
    if (gate) {
      gate.headers.set('cache-control', 'no-store');
      return gate;
    }
    const entries = await Promise.all(
      Object.values(config.hosts).map(async (h) => [h.label, (await readState(env, config, h, now)) ?? INITIAL_STATE]),
    );
    return Response.json(
      { org: config.org, domain: config.domain, hosts: Object.fromEntries(entries) },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  const host = matchHost(config, url.hostname);
  if (!host) return new Response(`no route for ${url.hostname}`, { status: 404 });

  const gate = accessGate(host, request.headers);
  if (gate) return gate;

  const state = await readState(env, config, host, now);
  const decision = chooseOrigin(host, state, now);

  let res;
  let networkError = false;
  try {
    res = await proxy(request, decision.origin, host);
  } catch (err) {
    networkError = true;
    res = new Response(`upstream error: ${err?.message ?? err}`, { status: 502 });
  }

  let servedBy = decision.origin;
  let reason = decision.reason;
  if (decision.origin === host.primary && shouldRetryOnFallback(host, request.method, res.status, networkError)) {
    try {
      const retry = await proxy(request, host.fallback, host);
      servedBy = host.fallback;
      reason = `primary-error-${networkError ? 'net' : res.status}-fallback`;
      res = retry;
      // Nudge the health record so the cron sees a failure sooner. Fire-and-forget.
      ctx.waitUntil(markPrimarySuspect(env, config, host, now));
    } catch {
      // keep the primary's error response
    }
  }

  if (res.status === 101) return res; // websocket upgrade: do not touch headers
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: decorateResponseHeaders(res.headers, { reason }, servedBy),
  });
}

async function markPrimarySuspect(env, config, host, now) {
  if (!env.HEALTH) return;
  const key = kvKey(config, host.label);
  const prev = (await env.HEALTH.get(key, 'json')) ?? INITIAL_STATE;
  // Only age the record; the cron owns the real transition. Ageing makes the
  // next request re-read KV and the next cron tick count a real probe.
  await env.HEALTH.put(key, JSON.stringify({ ...prev, checkedAt: Math.min(prev.checkedAt, now - host.health.staleAfterSeconds * 1000) }));
  stateCache.delete(key);
}

async function handleScheduled(_event, env, ctx) {
  const config = loadConfig(env);
  const now = Date.now();
  const results = await Promise.all(
    Object.values(config.hosts)
      .filter((h) => h.fallback) // no fallback => no point probing
      .map((h) => refreshHost(env, config, h, fetch, now)),
  );
  for (const r of results) {
    if (r.prev.up !== r.next.up) {
      console.log(JSON.stringify({ level: 'warn', event: 'health-transition', key: r.key, from: r.prev.up ? 'up' : 'down', to: r.next.up ? 'up' : 'down', error: r.next.lastError }));
    }
  }
  ctx.waitUntil(Promise.resolve());
  stateCache.clear();
}

export default {
  fetch: handleFetch,
  scheduled: handleScheduled,
};
