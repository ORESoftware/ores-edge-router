# ores-edge-router

One Cloudflare Worker that fronts every org apex domain and implements the
AGENTS.md subdomain contract with **health-based failover**:

| subdomain | primary origin | fallback origin |
|---|---|---|
| `auth.<domain>` | shared-auth on `k8s-cluster` | shared-auth on Cloud Run |
| `org.<domain>`, `user.<domain>` | `*-web-server.rs` on `k8s-cluster` | same image on Cloud Run |
| `api.<domain>` | `*-api-server.rs` on `k8s-cluster` | same image on Cloud Run |
| `admin.<domain>`, `api-admin.<domain>` | admin servers on `k8s-cluster` (Cloudflare Access required) | none — admin has no public fallback |

The primary is used while **both** `/healthz` and `/readyz` on the k8s origin
return 2xx; a cron probe every minute records the state in KV with hysteresis
(`failThreshold` consecutive failures to go down, `recoverThreshold` to come
back). Independently, an idempotent request that gets a 502/503/504/52x or a
connection error from the primary is retried against the fallback in the same
request, so a fresh outage is covered before the cron notices it.

Every response carries `x-ores-origin: k8s|cloudrun|cdn|github|pages` and
`x-ores-route: <reason>`. `/__ores/router/healthz` is always public for
router liveness. `GET https://<any host>/__ores/router/status` returns the
per-host health table only after the top-level `statusAccess` policy passes;
it defaults to `cloudflare-access`, can be made explicitly `public`, or can
be disabled with `deny`. Status and access-failure responses are `no-store`.

## Cloudflare Access verification

`access: "cloudflare-access"` is a cryptographic policy, not a header-presence
check. The Worker verifies `Cf-Access-Jwt-Assertion` using Cloudflare Access's
remote JWKS and checks the expected issuer and application audience. The
`Cf-Access-Authenticated-User-Email` header alone never authenticates a
request.

Configure the Worker with:

```text
CF_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com
CF_ACCESS_AUD=<application-aud-tag>
```

If different protected hosts use different Access applications, use a JSON
map instead of one global audience:

```text
CF_ACCESS_AUDIENCES={"admin":"<aud-admin>","api-admin":"<aud-api-admin>","admin.example.com":"<aud-host-specific>"}
```

`CF_ACCESS_AUDIENCES` may be keyed by router label or full public hostname; a
full-host match wins. A protected route with no verifier configuration returns
503 rather than silently downgrading authentication. Missing, malformed,
expired, wrong-issuer, wrong-audience, or bad-signature assertions return 403.

Access credentials are also an edge-only concern: the Worker strips the Access
JWT, authenticated-user header, and the `CF_Authorization` cookie before the
request reaches the application origin.

## Trusted proxy boundary

Incoming forwarding and ORES-routing metadata is untrusted. Before proxying,
the Worker removes hop-by-hop headers (including every header named by the
incoming `Connection` field), `Forwarded`, `X-Forwarded-*`, `X-Real-IP`,
`X-Ores-*`, and Cloudflare Access identity material. It then reconstructs
`Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`, and `X-Forwarded-For` from
trusted Worker context. `Connection: Upgrade` and `Upgrade: websocket` are
re-created only for an explicitly enabled WebSocket route.

This prevents callers from smuggling a fake project/session/service identity or
spoofing the client/proxy chain through headers that happen to survive multiple
reverse proxies.

## How an org adopts it

The contract for an org is a single `router.config.json` (validated by
`schemas/router.config.schema.json`) kept in the org's `*-infra` repo under
`cloudflare/edge-router/`. `wrangler.toml` is **rendered** from it — never
hand-edited. Copy `templates/infra-consumer/` into the infra repo, then:

```sh
cd cloudflare/edge-router
npm install
cp ../../../ores-edge-router/examples/apostille-me.router.config.json router.config.json   # edit
wrangler kv namespace create HEALTH          # once per org; put the id in CF_HEALTH_KV_ID
HEALTH_KV_ID=<id> npm run deploy
```

`origin-hetzner.<domain>` / `origin-aws.<domain>` are the **unproxied** A records
pointing at the cluster edge (see `zed-infra/docs/dns-zpkg-net.md` for the
convention); the Worker sends the public hostname as `Host` so the cluster
ingress routes by host exactly as it does today. Cloud Run origins receive their
own `*.a.run.app` host (set `hostHeader`) because Cloud Run routes by that.

DNS records for the six subdomains are proxied CNAMEs/A records managed in
`ores/cloudflare-infra` (Terraform); Worker routes are owned by this
`wrangler.toml`, per the split documented there.

## Precedent and reconciliation

`shared-auth-infra/workers/shared-auth-gateway` (ores-shared-auth.com) already implements the same
semantics for one zone — `/readyz`-gated ordered origins, safe-method failover on network errors /
502-504, controlled JSON 503 with `Retry-After` when nothing is ready — and honeypot-r-us
(`hnpt-edge-router-prod`) and 3FA (`multiapp-gateway`) run bespoke workers. This repo is the
fleet-wide, config-driven form of that pattern; those three should converge on it (or feed
their extra behaviour back here) so every org runs identical edge code.

## Design notes

- Pure decision functions (`src/routing.mjs`, `src/health.mjs#transition`) are
  separated from effects (`src/index.mjs`), and are unit-tested with
  `node --test`.
- Access verification lives in `src/access.mjs`; tests inject a verifier so JWT
  policy is exercised without network calls.
- Health is probed with the same `Host` header traffic uses, so a readiness
  failure of the specific ingress route — not just the node — flips traffic.
- `mode: "redirect"` fallbacks (R2 `cdn.zpkg.net`, GitHub Pages) let a static
  origin cover a dynamic host's outage for the paths it can serve.
- Admin subdomains default to `access: cloudflare-access` and fail closed unless
  the Access JWT verifies for the configured issuer and audience.
- The router status endpoint separately defaults to `statusAccess: cloudflare-access`;
  its gate runs before KV health state is read.
- Non-idempotent requests are never replayed against the fallback.

## Layout

```
src/            worker (access, config, health, routing, index)
schemas/        router.config.schema.json — the contract
scripts/        render-wrangler.mjs, validate-config.mjs
examples/       apostille-me, zed-pkg (zpkg.net with CDN/GitHub fallbacks)
templates/      drop-in for *-infra repos (package.json + GitHub Actions deploy)
test/           node:test unit tests
```
