# edge rate limiting

Driver: `ORESoftware/ores-edge-router#12`

This file defines a bounded, independently reviewable contract slice for the driver issue. It does not claim the full implementation is complete.

## Invariants

- Edge limiting is coarse abuse protection and never the billable quota authority.
- Forward authenticated policy/tenant context without trusting client-supplied quota counters.
- Fail closed on malformed limiter decisions while avoiding amplification under overload.
- Expose bounded retry/backpressure metadata that can be reconciled with canonical middleware decisions.

## Verification

- Exercise the exact PR head with the repository's relevant tests/checks.
- Include fail-closed negative cases for stale, malformed, or unsupported states.
- Keep generated/runtime authority boundaries explicit.
- Treat skipped or zero-step CI as missing evidence.

## Non-goals

No secrets, direct protected-branch mutations, or silent compatibility downgrades are introduced here.
