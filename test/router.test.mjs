import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeConfig, ConfigError, missingCanonicalLabels } from '../src/config.mjs';
import { transition, INITIAL_STATE, isStale, probeOrigin } from '../src/health.mjs';
import { matchHost, chooseOrigin, shouldRetryOnFallback, upstreamUrl, upstreamHeaders, accessGate } from '../src/routing.mjs';

const example = () => normalizeConfig(JSON.parse(readFileSync(new URL('../examples/apostille-me.router.config.json', import.meta.url), 'utf8')));

test('config: example normalizes, admin defaults to cloudflare-access', () => {
  const c = example();
  assert.equal(c.domain, 'apostille.me');
  assert.equal(c.hosts.api.primary.hostHeader, 'api.apostille.me');
  assert.equal(c.hosts.admin.access, 'cloudflare-access');
  assert.equal(c.hosts.api.access, 'public');
  assert.deepEqual(missingCanonicalLabels(c), []);
});

test('config: rejects origin with a path and unknown kinds', () => {
  assert.throws(() => normalizeConfig({ org: 'x', domain: 'x.io', hosts: { api: { primary: { url: 'https://h/p' } } } }), ConfigError);
  assert.throws(() => normalizeConfig({ org: 'x', domain: 'x.io', hosts: { api: { primary: { url: 'https://h', kind: 'lambda' } } } }), ConfigError);
  assert.throws(() => normalizeConfig({ org: 'x', domain: 'x.io', hosts: {} }), ConfigError);
  assert.throws(() => normalizeConfig({ org: 'x', domain: 'x.io', hosts: { 'Bad_Label': { primary: { url: 'https://h' } } } }), ConfigError);
});

test('config: host-level health overrides org-level', () => {
  const c = normalizeConfig({ org: 'x', domain: 'x.io', health: { failThreshold: 5 }, hosts: {
    api: { primary: { url: 'https://a' } },
    web: { primary: { url: 'https://a' }, health: { failThreshold: 1 } },
  } });
  assert.equal(c.hosts.api.health.failThreshold, 5);
  assert.equal(c.hosts.web.health.failThreshold, 1);
  assert.equal(c.hosts.web.health.recoverThreshold, 2);
});

test('health: hysteresis needs failThreshold consecutive failures and recoverThreshold successes', () => {
  const h = { failThreshold: 2, recoverThreshold: 2, staleAfterSeconds: 180, paths: ['/healthz'], timeoutMs: 1000 };
  let s = INITIAL_STATE;
  s = transition(s, { ok: false, error: 'boom' }, h, 1000);
  assert.equal(s.up, true, 'one failure does not flip');
  s = transition(s, { ok: false, error: 'boom' }, h, 2000);
  assert.equal(s.up, false, 'second consecutive failure flips down');
  s = transition(s, { ok: true }, h, 3000);
  assert.equal(s.up, false, 'one success does not recover');
  s = transition(s, { ok: false }, h, 4000);
  assert.equal(s.consecutiveOk, 0, 'failure resets the ok streak');
  s = transition(s, { ok: true }, h, 5000);
  s = transition(s, { ok: true }, h, 6000);
  assert.equal(s.up, true, 'two consecutive successes recover');
  assert.equal(s.lastError, null);
});

test('health: staleness', () => {
  const h = { staleAfterSeconds: 60 };
  assert.equal(isStale(null, h, 0), true);
  assert.equal(isStale({ checkedAt: 0 }, h, 59_000), false);
  assert.equal(isStale({ checkedAt: 0 }, h, 61_000), true);
});

test('health: probe requires ALL paths 2xx and honours Host header', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init.headers.Host]);
    return new Response('', { status: url.endsWith('/readyz') ? 503 : 200 });
  };
  const origin = { url: 'https://origin-hetzner.apostille.me', pathPrefix: '', hostHeader: 'api.apostille.me' };
  const r = await probeOrigin(fetchImpl, origin, { paths: ['/healthz', '/readyz'], timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /readyz -> HTTP 503/);
  assert.deepEqual(seen.map((s) => s[1]), ['api.apostille.me', 'api.apostille.me']);
  const ok = await probeOrigin(async () => new Response('ok', { status: 200 }), origin, { paths: ['/healthz', '/readyz'], timeoutMs: 1000 });
  assert.equal(ok.ok, true);
});

test('health: probe timeout is reported as timeout', async () => {
  const fetchImpl = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const r = await probeOrigin(fetchImpl, { url: 'https://o', pathPrefix: '', hostHeader: 'x' }, { paths: ['/healthz'], timeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timeout/);
});

test('routing: matchHost', () => {
  const c = example();
  assert.equal(matchHost(c, 'api.apostille.me').label, 'api');
  assert.equal(matchHost(c, 'API.Apostille.ME.').label, 'api');
  assert.equal(matchHost(c, 'nope.apostille.me'), null);
  assert.equal(matchHost(c, 'api.evil.com'), null);
  assert.equal(matchHost(c, 'apostille.me'), null);
});

test('routing: chooseOrigin prefers healthy primary, falls back when down, primary when unknown', () => {
  const c = example();
  const api = c.hosts.api;
  const now = 100_000;
  assert.equal(chooseOrigin(api, { up: true, checkedAt: now - 1000 }, now).origin.kind, 'k8s');
  assert.equal(chooseOrigin(api, { up: false, checkedAt: now - 1000 }, now).origin.kind, 'cloudrun');
  assert.equal(chooseOrigin(api, { up: false, checkedAt: now - 1_000_000 }, now).reason, 'health-unknown');
  assert.equal(chooseOrigin(api, null, now).origin.kind, 'k8s');
  assert.equal(chooseOrigin(c.hosts.admin, { up: false, checkedAt: now }, now).reason, 'no-fallback');
});

test('routing: retry only idempotent methods on gateway-class failures', () => {
  const api = example().hosts.api;
  assert.equal(shouldRetryOnFallback(api, 'GET', 503, false), true);
  assert.equal(shouldRetryOnFallback(api, 'GET', 500, false), false, '500 is an app error, not an outage');
  assert.equal(shouldRetryOnFallback(api, 'POST', 503, false), false);
  assert.equal(shouldRetryOnFallback(api, 'GET', 0, true), true);
  assert.equal(shouldRetryOnFallback(example().hosts.admin, 'GET', 503, false), false);
});

test('routing: upstreamUrl keeps path+query and applies pathPrefix', () => {
  const o = { url: 'https://cdn.zpkg.net', pathPrefix: '/artifacts', hostHeader: 'cdn.zpkg.net' };
  assert.equal(upstreamUrl(o, 'https://registry.zpkg.net/pkg/a?b=1').toString(), 'https://cdn.zpkg.net/artifacts/pkg/a?b=1');
});

test('routing: upstreamHeaders sets Host and forwarded headers, strips hop-by-hop', () => {
  const h = upstreamHeaders(new Headers({ host: 'api.apostille.me', 'transfer-encoding': 'chunked', 'x-a': '1' }), { hostHeader: 'origin.internal' }, '1.2.3.4');
  assert.equal(h.get('host'), 'origin.internal');
  assert.equal(h.get('x-forwarded-host'), 'api.apostille.me');
  assert.equal(h.get('x-forwarded-for'), '1.2.3.4');
  assert.equal(h.get('transfer-encoding'), null);
  assert.equal(h.get('x-a'), '1');
});

test('routing: accessGate', () => {
  const c = example();
  assert.equal(accessGate(c.hosts.api, new Headers()), null);
  assert.equal(accessGate(c.hosts.admin, new Headers()).status, 403);
  assert.equal(accessGate(c.hosts.admin, new Headers({ 'cf-access-jwt-assertion': 'x' })), null);
  const deny = normalizeConfig({ org: 'x', domain: 'x.io', hosts: { admin: { primary: { url: 'https://a' }, access: 'deny' } } });
  assert.equal(accessGate(deny.hosts.admin, new Headers({ 'cf-access-jwt-assertion': 'x' })).status, 404);
});

test('config: unavailable fallback needs no url and chooseOrigin returns it when primary is down', () => {
  const c = normalizeConfig({ org: 'x', domain: 'x.io', hosts: { api: { primary: { url: 'https://a' }, fallback: { mode: 'unavailable', retryAfter: 7 } } } });
  assert.equal(c.hosts.api.fallback.mode, 'unavailable');
  assert.equal(c.hosts.api.fallback.retryAfter, 7);
  assert.equal(chooseOrigin(c.hosts.api, { up: false, checkedAt: 1000 }, 2000).origin.mode, 'unavailable');
});
