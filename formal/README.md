# Edge router bounded model/refinement gate

`test/formal-refinement.test.mjs` enumerates a finite state space and compares
the real production functions in `src/health.mjs` and `src/routing.mjs` to
independently specified safety predicates:

- health hysteresis for all 128 seven-probe histories and 1..3 failure and
  recovery thresholds, including witnesses for both failure and recovery;
- race admission across methods, websocket state, strategies, fallback
  presence and both origin modes;
- retry admission for status codes, transport errors and policy flags;
- stale/unknown health selection without fabricating fallback availability.

Run `npm test`; the normal CI test job executes this suite. A counterexample
causes a nonzero exit. The finite bounds and witness counts prevent a passing
test from being mistaken for unlimited-state or vacuous verification.

**Limits:** This is a bounded refinement test of pure routing decisions.
It is not a proof of upstream request delivery, KV atomicity, network
partition recovery, or Cloudflare execution.

## AttoLang integration boundary

Future `.atto` edge adapter implementations must preserve these observable
routing contracts and use the language-neutral `fm.adapter.stream.v1` model
adapter protocol from `ORESoftware/formal-methods.rs`. A sample `.atto`
file, a host-language test or an unsuccessful GitHub Actions admission is
**not** proof of backend execution. Require named backend, immutable commit,
executed trace and the equivalent negative cases before claiming parity.
