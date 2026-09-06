import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig, ConfigError } from '../src/config.mjs';
import { handleFetch } from '../src/index.mjs';

function statusEnv(statusAccess) {
  const config = {
    org: 'x',
    domain: 'x.io',
    hosts: { api: { primary: { url: 'https://a' } } },
  };
  if (statusAccess !== undefined) config.statusAccess = statusAccess;
  return {
    ROUTER_CONFIG: JSON.stringify(config),
    HEALTH: {
      async get() {
        throw new Error('status gate must run before KV is read');
      },
    },
  };
}

const ctx = { waitUntil() {} };

test('status config defaults to Cloudflare Access and rejects unknown policies', () => {
  const base = {
    org: 'x',
    domain: 'x.io',
    hosts: { api: { primary: { url: 'https://a' } } },
  };
  assert.equal(normalizeConfig(base).statusAccess, 'cloudflare-access');
  assert.throws(
    () => normalizeConfig({ ...base, statusAccess: 'token' }),
    ConfigError,
  );
});

test('router status default denies before reading health KV', async () => {
  const response = await handleFetch(
    new Request('https://api.x.io/__ores/router/status'),
    statusEnv(undefined),
    ctx,
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('router status accepts Access assertion and returns a non-cacheable table', async () => {
  const env = statusEnv(undefined);
  env.HEALTH.get = async () => null;
  const response = await handleFetch(
    new Request('https://api.x.io/__ores/router/status', {
      headers: { 'cf-access-jwt-assertion': 'signed-by-access' },
    }),
    env,
    ctx,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.org, 'x');
  assert.equal(body.hosts.api.up, true);
});

test('router status public mode is explicit and deny mode stays indistinguishable', async () => {
  const publicEnv = statusEnv('public');
  publicEnv.HEALTH.get = async () => null;
  const publicResponse = await handleFetch(
    new Request('https://api.x.io/__ores/router/status'),
    publicEnv,
    ctx,
  );
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get('cache-control'), 'no-store');

  const denied = await handleFetch(
    new Request('https://api.x.io/__ores/router/status', {
      headers: { 'cf-access-jwt-assertion': 'signed-by-access' },
    }),
    statusEnv('deny'),
    ctx,
  );
  assert.equal(denied.status, 404);
  assert.equal(denied.headers.get('cache-control'), 'no-store');
});

test('router healthz remains public when status access is deny', async () => {
  const response = await handleFetch(
    new Request('https://api.x.io/__ores/router/healthz'),
    statusEnv('deny'),
    ctx,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
});
