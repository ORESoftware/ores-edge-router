// Config loading + normalization. Pure: takes the raw JSON object, returns a
// fully-defaulted, frozen config or throws a typed ConfigError.

export class ConfigError extends Error {
  constructor(message, path) {
    super(`${path}: ${message}`);
    this.name = 'ConfigError';
    this.path = path;
  }
}

export const CANONICAL_LABELS = Object.freeze(['auth', 'org', 'user', 'api', 'admin', 'api-admin']);
export const ADMIN_LABELS = Object.freeze(['admin', 'api-admin']);

const DEFAULT_HEALTH = Object.freeze({
  paths: Object.freeze(['/healthz', '/readyz']),
  timeoutMs: 3000,
  failThreshold: 2,
  recoverThreshold: 2,
  staleAfterSeconds: 180,
});

const ORIGIN_KINDS = new Set(['k8s', 'cloudrun', 'cdn', 'github', 'pages', 'tunnel', 'other']);
const ACCESS_MODES = new Set(['public', 'cloudflare-access', 'deny']);
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ORIGIN_URL_RE = /^https:\/\/[^/\s]+$/;

function normalizeOrigin(raw, path, publicHost) {
  if (!raw || typeof raw !== 'object') throw new ConfigError('origin must be an object', path);
  if (raw.mode === 'unavailable') {
    // Controlled outage answer: JSON 503 + Retry-After so API clients keep their own retry/fallback
    // logic instead of being redirected somewhere that answers 404. No url needed.
    return Object.freeze({ url: null, hostHeader: publicHost, kind: raw.kind ?? 'other', mode: 'unavailable', pathPrefix: '', retryAfter: raw.retryAfter ?? 5 });
  }
  if (typeof raw.url !== 'string' || !ORIGIN_URL_RE.test(raw.url)) {
    throw new ConfigError('origin.url must be https://host[:port] with no path', `${path}.url`);
  }
  const kind = raw.kind ?? 'other';
  if (!ORIGIN_KINDS.has(kind)) throw new ConfigError(`unknown origin kind ${kind}`, `${path}.kind`);
  const mode = raw.mode ?? 'proxy';
  if (mode !== 'proxy' && mode !== 'redirect') throw new ConfigError(`mode must be proxy|redirect|unavailable`, `${path}.mode`);
  const pathPrefix = raw.pathPrefix ?? '';
  if (typeof pathPrefix !== 'string' || (pathPrefix && !pathPrefix.startsWith('/'))) {
    throw new ConfigError('pathPrefix must be empty or start with /', `${path}.pathPrefix`);
  }
  return Object.freeze({
    url: raw.url,
    hostHeader: raw.hostHeader ?? publicHost,
    kind,
    mode,
    pathPrefix: pathPrefix.replace(/\/+$/, ''),
  });
}

function normalizeHealth(raw, path, base = DEFAULT_HEALTH) {
  if (raw === undefined) return base;
  if (!raw || typeof raw !== 'object') throw new ConfigError('health must be an object', path);
  const out = { ...base };
  if (raw.paths !== undefined) {
    if (!Array.isArray(raw.paths) || raw.paths.some((p) => typeof p !== 'string' || !p.startsWith('/'))) {
      throw new ConfigError('paths must be an array of /-prefixed strings', `${path}.paths`);
    }
    out.paths = Object.freeze([...raw.paths]);
  }
  for (const [k, min, max] of [
    ['timeoutMs', 200, 30000],
    ['failThreshold', 1, 10],
    ['recoverThreshold', 1, 10],
    ['staleAfterSeconds', 30, 3600],
  ]) {
    if (raw[k] !== undefined) {
      if (!Number.isInteger(raw[k]) || raw[k] < min || raw[k] > max) {
        throw new ConfigError(`${k} must be an integer in [${min}, ${max}]`, `${path}.${k}`);
      }
      out[k] = raw[k];
    }
  }
  return Object.freeze(out);
}

/**
 * @param {unknown} raw parsed router.config.json
 * @returns {Readonly<RouterConfig>}
 */
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new ConfigError('config must be an object', '$');
  const { org, domain, hosts } = raw;
  if (typeof org !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org)) throw new ConfigError('org is required', '$.org');
  if (typeof domain !== 'string' || !DOMAIN_RE.test(domain)) throw new ConfigError('domain must be an apex domain', '$.domain');
  if (!hosts || typeof hosts !== 'object' || Object.keys(hosts).length === 0) {
    throw new ConfigError('hosts must be a non-empty object keyed by subdomain label', '$.hosts');
  }
  const health = normalizeHealth(raw.health, '$.health');
  const outHosts = {};
  for (const [label, h] of Object.entries(hosts)) {
    const p = `$.hosts.${label}`;
    if (!LABEL_RE.test(label)) throw new ConfigError('invalid subdomain label', p);
    if (!h || typeof h !== 'object') throw new ConfigError('host must be an object', p);
    const publicHost = `${label}.${domain}`;
    const primary = normalizeOrigin(h.primary, `${p}.primary`, publicHost);
    const fallback = h.fallback === undefined ? null : normalizeOrigin(h.fallback, `${p}.fallback`, publicHost);
    const access = h.access ?? (ADMIN_LABELS.includes(label) ? 'cloudflare-access' : 'public');
    if (!ACCESS_MODES.has(access)) throw new ConfigError('access must be public|cloudflare-access|deny', `${p}.access`);
    outHosts[label] = Object.freeze({
      label,
      publicHost,
      primary,
      fallback,
      health: normalizeHealth(h.health, `${p}.health`, health),
      access,
      retryOnPrimaryError: h.retryOnPrimaryError ?? true,
      websocket: h.websocket ?? true,
    });
  }
  return Object.freeze({
    org,
    domain,
    linearProject: raw.linearProject ?? null,
    gcpProject: raw.gcpProject ?? null,
    health,
    hosts: Object.freeze(outHosts),
  });
}

/** Labels from the canonical contract that this config does not declare. */
export function missingCanonicalLabels(config) {
  return CANONICAL_LABELS.filter((l) => !(l in config.hosts));
}
