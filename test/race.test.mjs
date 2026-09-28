import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, ConfigError } from '../src/config.mjs';
import { shouldRaceOrigins } from '../src/routing.mjs';
import { handleFetch } from '../src/index.mjs';

function raceConfig() {
  return {
    org: 'example',
    domain: 'example.com',
    statusAccess: 'public',
    hosts: {
      api: {
        primary: { url: 'https://supabase-origin.example', kind: 'other' },
        fallback: { url: 'https://neon-origin.example', kind: 'other' },
        strategy: 'race',
        access: 'public',
      },
    },
  };
}

function envFor(raw = raceConfig()) {
  return { ROUTER_CONFIG: JSON.stringify(raw) };
}

const ctx = { waitUntil() {} };

function delayedResponse(ms, body, status = 200) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(new Response(body, { status })), ms);
  });
}

test('config: race requires two proxy origins', () => {
  const c = normalizeConfig(raceConfig());
  assert.equal(c.hosts.api.strategy, 'race');

  const noFallback = raceConfig();
  delete noFallback.hosts.api.fallback;
  assert.throws(() => normalizeConfig(noFallback), ConfigError);

  const redirectFallback = raceConfig();
  redirectFallback.hosts.api.fallback.mode = 'redirect';
  assert.throws(() => normalizeConfig(redirectFallback), ConfigError);
});

test('routing: race is restricted to idempotent non-websocket requests', () => {
  const host = normalizeConfig(raceConfig()).hosts.api;
  assert.equal(shouldRaceOrigins(host, 'GET'), true);
  assert.equal(shouldRaceOrigins(host, 'HEAD'), true);
  assert.equal(shouldRaceOrigins(host, 'OPTIONS'), true);
  assert.equal(shouldRaceOrigins(host, 'POST'), false);
  assert.equal(shouldRaceOrigins(host, 'PUT'), false);
  assert.equal(shouldRaceOrigins(host, 'PATCH'), false);
  assert.equal(shouldRaceOrigins(host, 'DELETE'), false);
  assert.equal(shouldRaceOrigins(host, 'GET', true), false);
});

test('worker: safe reads return the first healthy raced origin', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url.startsWith('https://supabase-origin.example')) {
      return delayedResponse(30, 'supabase');
    }
    return delayedResponse(5, 'neon');
  };

  try {
    const res = await handleFetch(new Request('https://api.example.com/read'), envFor(), ctx);
    assert.equal(await res.text(), 'neon');
    assert.equal(res.headers.get('x-ores-route'), 'race-fallback');
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker: gateway failure in one race lane waits for the other lane', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.startsWith('https://supabase-origin.example')) {
      return delayedResponse(1, 'unavailable', 503);
    }
    return delayedResponse(5, 'neon-ok', 200);
  };

  try {
    const res = await handleFetch(new Request('https://api.example.com/read'), envFor(), ctx);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'neon-ok');
    assert.equal(res.headers.get('x-ores-route'), 'race-fallback');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('worker: mutation is sent exactly once even when strategy is race', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return new Response('created', { status: 201 });
  };

  try {
    const res = await handleFetch(new Request('https://api.example.com/write', {
      method: 'POST',
      body: JSON.stringify({ value: 1 }),
      headers: { 'content-type': 'application/json' },
    }), envFor(), ctx);
    assert.equal(res.status, 201);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^https:\/\/supabase-origin\.example/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
