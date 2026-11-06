// Finite-state refinement: independent abstract safety expectations checked
// against the actual pure production routing and health functions.
// This is exhaustive for the stated finite input domains, not a proof of
// distributed KV consistency, upstream transport, or an AttoLang backend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_STATE, transition, isStale } from '../src/health.mjs';
import {
  shouldRaceOrigins, shouldRetryOnFallback, chooseOrigin, isGatewayFailure,
  upstreamHeaders,
} from '../src/routing.mjs';

const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE'];
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const GATEWAY = new Set([502, 503, 504, 521, 522, 523]);

function abstractHealth(history, failThreshold, recoverThreshold) {
  let up = true;
  let run = 0;
  let last = null;
  for (const ok of history) {
    run = ok === last ? run + 1 : 1;
    if (!ok && up && run >= failThreshold) up = false;
    if (ok && !up && run >= recoverThreshold) up = true;
    last = ok;
  }
  return up;
}

test('bounded model: hysteresis and stale health (all 7-probe traces, thresholds 1..3)', () => {
  let steps = 0;
  let downWitnesses = 0;
  let recoveryWitnesses = 0;
  for (let failThreshold = 1; failThreshold <= 3; failThreshold++) {
    for (let recoverThreshold = 1; recoverThreshold <= 3; recoverThreshold++) {
      const health = { failThreshold, recoverThreshold, staleAfterSeconds: 2 };
      for (let bits = 0; bits < 128; bits++) {
        const history = [];
        let state = INITIAL_STATE;
        for (let i = 0; i < 7; i++) {
          const ok = (bits & (1 << i)) !== 0;
          history.push(ok);
          const previous = state;
          state = transition(state, { ok, error: ok ? undefined : 'probe-failed' }, health, i * 1000);
          steps++;
          assert.equal(state.up, abstractHealth(history, failThreshold, recoverThreshold));
          const suffix = history.slice().reverse();
          const run = suffix.findIndex((item) => item !== ok);
          const consecutive = run < 0 ? suffix.length : run;
          assert.equal(ok ? state.consecutiveOk : state.consecutiveFail, consecutive);
          assert.equal(ok ? state.consecutiveFail : state.consecutiveOk, 0);
          assert.equal(state.checkedAt, i * 1000);
          assert.equal(state.lastError, ok ? null : 'probe-failed');
          // A single probe cannot flip a healthy host below the failure threshold
          // or revive a down host below the recovery threshold.
          if (previous.up && !ok && consecutive < failThreshold) assert.equal(state.up, true);
          if (!previous.up && ok && consecutive < recoverThreshold) assert.equal(state.up, false);
          if (previous.up && !state.up) downWitnesses++;
          if (!previous.up && state.up) recoveryWitnesses++;
          assert.equal(isStale(state, health, i * 1000 + 2000), false);
          assert.equal(isStale(state, health, i * 1000 + 2001), true);
        }
      }
    }
  }
  assert.equal(steps, 9 * 128 * 7);
  assert.ok(downWitnesses > 0 && recoveryWitnesses > 0, 'non-vacuous failure/recovery witnesses');
});

test('finite refinement: racing is possible only for idempotent, non-websocket proxy pairs', () => {
  let accepted = 0;
  let rejected = 0;
  for (const method of METHODS) {
    for (const websocket of [false, true]) {
      for (const strategy of ['race', 'primary']) {
        for (const fallbackPresent of [false, true]) {
          for (const primaryMode of ['proxy', 'redirect']) {
            for (const fallbackMode of ['proxy', 'redirect']) {
              const host = {
                strategy, primary: { mode: primaryMode },
                fallback: fallbackPresent ? { mode: fallbackMode } : null,
              };
              const expected = strategy === 'race' && fallbackPresent
                && primaryMode === 'proxy' && fallbackMode === 'proxy'
                && READS.has(method) && !websocket;
              assert.equal(shouldRaceOrigins(host, method, websocket), expected,
                JSON.stringify({ method, websocket, strategy, fallbackPresent, primaryMode, fallbackMode }));
              if (expected) accepted++; else rejected++;
              if (!READS.has(method) || websocket) assert.equal(shouldRaceOrigins(host, method, websocket), false);
            }
          }
        }
      }
    }
  }
  assert.ok(accepted > 0 && rejected > 0, 'non-vacuous race admission');
});

test('finite refinement: fallback retries only safe operations after gateway failure', () => {
  const statuses = [200, 201, 400, 401, 404, 429, 500, 502, 503, 504, 521, 522, 523];
  let admitted = 0;
  for (const method of METHODS) {
    for (const status of statuses) {
      for (const networkError of [false, true]) {
        for (const fallbackPresent of [false, true]) {
          for (const retryEnabled of [false, true]) {
            const host = { fallback: fallbackPresent ? { mode: 'proxy' } : null,
              retryOnPrimaryError: retryEnabled };
            const failure = GATEWAY.has(status) || networkError;
            assert.equal(isGatewayFailure(status, networkError), failure);
            const expected = fallbackPresent && retryEnabled && READS.has(method) && failure;
            assert.equal(shouldRetryOnFallback(host, method, status, networkError), expected);
            if (expected) admitted++;
          }
        }
      }
    }
  }
  assert.ok(admitted > 0, 'expected admitted gateway retries');
});

test('finite refinement: stale health fails back to primary, never an unproven fallback', () => {
  const primary = { mode: 'proxy', url: 'https://primary.example' };
  const fallback = { mode: 'proxy', url: 'https://fallback.example' };
  const host = { primary, fallback, health: { staleAfterSeconds: 2 } };
  for (const up of [true, false]) {
    for (const ageMs of [0, 2000, 2001]) {
      const result = chooseOrigin(host, { up, checkedAt: 1000 }, 1000 + ageMs);
      const stale = ageMs > 2000;
      assert.equal(result.origin, stale || up ? primary : fallback);
      assert.equal(result.primaryUp, stale ? null : up);
    }
  }
  assert.equal(chooseOrigin({ primary, fallback: null, health: host.health }, null, 1000).origin, primary);
});

test('HTTP method case is a safety boundary, not an interchangeable spelling', () => {
  const host = {
    strategy: 'race', retryOnPrimaryError: true,
    primary: { mode: 'proxy' }, fallback: { mode: 'proxy' },
  };
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(shouldRaceOrigins(host, method, false), true, method);
    assert.equal(shouldRetryOnFallback(host, method, 503, false), true, method);
  }
  for (const method of ['get', 'head', 'options', 'GeT', 'GET ', ' GET', 'POST',
    'DELETE', 'PATCH', 'TRACE', 'CONNECT', 'GET\\n', 'get\\0']) {
    assert.equal(shouldRaceOrigins(host, method, false), false, method);
    assert.equal(shouldRetryOnFallback(host, method, 503, true), false, method);
  }
});

test('proxy header refinement never forwards client-asserted authority or dynamic hop fields', () => {
  const source = new Headers({
    'Connection': 'X-Extra-Hop, Upgrade',
    'X-Extra-Hop': 'untrusted',
    'Forwarded': 'for=evil.example',
    'X-Forwarded-For': '203.0.113.13',
    'X-Forwarded-Host': 'internal.example',
    'X-Real-IP': '203.0.113.13',
    'CF-Access-Jwt-Assertion': 'forged',
    'CF-Access-Authenticated-User-Email': 'forged@example.com',
    'X-Ores-Role': 'admin',
    'Authorization': 'Bearer application-credential',
    'Cookie': 'cf_authorization=forged; session=kept; CF_Authorization=forged2',
    'X-Public-Marker': 'value',
    'Host': 'evil.example',
    'Upgrade': 'websocket',
  });
  const origin = { hostHeader: 'trusted.internal' };
  for (const websocket of [false, true]) {
    const h = upstreamHeaders(source, origin, '192.0.2.9', 'public.example', { websocket });
    for (const name of ['x-extra-hop', 'forwarded', 'x-real-ip', 'cf-access-jwt-assertion',
      'cf-access-authenticated-user-email', 'x-ores-role']) {
      assert.equal(h.has(name), false, name);
    }
    assert.equal(h.get('host'), 'trusted.internal');
    assert.equal(h.get('x-forwarded-host'), 'public.example');
    assert.equal(h.get('x-forwarded-proto'), 'https');
    assert.equal(h.get('x-forwarded-for'), '192.0.2.9');
    assert.equal(h.get('authorization'), 'Bearer application-credential');
    assert.equal(h.get('x-public-marker'), 'value');
    assert.equal(h.get('cookie'), 'session=kept');
    assert.equal(h.get('upgrade'), websocket ? 'websocket' : null);
    assert.equal(h.get('connection'), websocket ? 'Upgrade' : null);
  }
});
