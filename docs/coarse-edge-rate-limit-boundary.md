# Coarse edge rate-limit boundary

Tracking: #12.

Edge limiting is coarse abuse, connection, and anonymous-flood protection. Authoritative tenant/user/plan accounting remains in `ores-rate-limit` after trusted identity establishment.

The edge forwards origin `RateLimit-Policy`, `RateLimit`, and `Retry-After` unless it intentionally applies a stricter compatible intermediary policy; it never loosens origin metadata. Client-supplied forwarding headers are not trusted outside the middleware trusted-proxy boundary, and no header bypasses limiting.

Machine-readable denial metadata distinguishes edge flood protection from purchased-quota exhaustion. Preserve 429 for rate/quota denial and 503 for origin capacity/backend unavailability. Apply bounded header/body/connection ceilings before expensive auth/quota work.

Certification covers direct origin, Cloudflare tunnel, spoofed/duplicate forwarding chains, missing rate-limit metadata, stricter intermediary policy, and origin 429/503 pass-through.