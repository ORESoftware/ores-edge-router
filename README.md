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
`x-ores-route: <reason>`. `GET https://<any host>/__ores/router/status` dumps
the health table; `/__ores/router/healthz` is the router's own liveness.

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

## Design notes

- Pure decision functions (`src/routing.mjs`, `src/health.mjs#transition`) are
  separated from effects (`src/index.mjs`), and are unit-tested with
  `node --test`; no network in tests.
- Health is probed with the same `Host` header traffic uses, so a readiness
  failure of the specific ingress route — not just the node — flips traffic.
- `mode: "redirect"` fallbacks (R2 `cdn.zpkg.net`, GitHub Pages) let a static
  origin cover a dynamic host's outage for the paths it can serve.
- Admin subdomains default to `access: cloudflare-access` and are refused when
  no Access assertion is present, matching the "no public ingress" rule.
- Non-idempotent requests are never replayed against the fallback.

## Layout

```
src/            worker (config, health, routing, index)
schemas/        router.config.schema.json — the contract
scripts/        render-wrangler.mjs, validate-config.mjs
examples/       apostille-me, zed-pkg (zpkg.net with CDN/GitHub fallbacks)
templates/      drop-in for *-infra repos (package.json + GitHub Actions deploy)
test/           node:test unit tests
```
