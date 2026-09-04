// Health state machine + probe. The state transition is a pure function of
// (previous state, probe outcome, thresholds, now); the probe itself is the
// only effect and is injected so tests never touch the network.

/** @typedef {{ up: boolean, consecutiveOk: number, consecutiveFail: number, checkedAt: number, lastError: string|null }} HealthState */

export const INITIAL_STATE = Object.freeze({
  up: true, // optimistic: a brand-new host routes to the primary until proven down
  consecutiveOk: 0,
  consecutiveFail: 0,
  checkedAt: 0,
  lastError: null,
});

/**
 * Pure transition. Hysteresis: needs `failThreshold` consecutive failures to go
 * down and `recoverThreshold` consecutive successes to come back up, so one
 * flaky probe never flips traffic.
 */
export function transition(prev, outcome, health, now) {
  const ok = outcome.ok === true;
  const consecutiveOk = ok ? prev.consecutiveOk + 1 : 0;
  const consecutiveFail = ok ? 0 : prev.consecutiveFail + 1;
  let up = prev.up;
  if (prev.up && consecutiveFail >= health.failThreshold) up = false;
  if (!prev.up && consecutiveOk >= health.recoverThreshold) up = true;
  return Object.freeze({
    up,
    consecutiveOk,
    consecutiveFail,
    checkedAt: now,
    lastError: ok ? null : String(outcome.error ?? 'probe failed'),
  });
}

/** True when the stored state is too old to trust. */
export function isStale(state, health, now) {
  return !state || now - state.checkedAt > health.staleAfterSeconds * 1000;
}

/**
 * Probe every health path on the origin. ALL must be 2xx within timeoutMs.
 * @param {typeof fetch} fetchImpl
 */
export async function probeOrigin(fetchImpl, origin, health) {
  const results = await Promise.all(
    health.paths.map(async (path) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), health.timeoutMs);
      try {
        const res = await fetchImpl(`${origin.url}${origin.pathPrefix}${path}`, {
          method: 'GET',
          headers: { Host: origin.hostHeader, 'User-Agent': 'ores-edge-router/health' },
          redirect: 'manual',
          signal: ctrl.signal,
          cf: { cacheTtl: 0 },
        });
        if (res.status >= 200 && res.status < 300) return { ok: true, path };
        return { ok: false, path, error: `${path} -> HTTP ${res.status}` };
      } catch (err) {
        return { ok: false, path, error: `${path} -> ${err?.name === 'AbortError' ? 'timeout' : err?.message ?? err}` };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const failed = results.filter((r) => !r.ok);
  return failed.length === 0 ? { ok: true } : { ok: false, error: failed.map((f) => f.error).join('; ') };
}

export function kvKey(config, label) {
  return `health:${config.domain}:${label}`;
}

/** Read-modify-write one host's health into KV. */
export async function refreshHost(env, config, host, fetchImpl, now = Date.now()) {
  const key = kvKey(config, host.label);
  const prevRaw = await env.HEALTH.get(key, 'json');
  const prev = prevRaw ?? INITIAL_STATE;
  const outcome = await probeOrigin(fetchImpl, host.primary, host.health);
  const next = transition(prev, outcome, host.health, now);
  await env.HEALTH.put(key, JSON.stringify(next), { expirationTtl: Math.max(60, host.health.staleAfterSeconds * 4) });
  return { key, prev, next, outcome };
}
