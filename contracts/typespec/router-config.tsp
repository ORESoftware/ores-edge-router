namespace Ores.EdgeRouter;

enum AccessPolicy {
  public,
  `cloudflare-access`,
  deny,
}

enum OriginKind {
  k8s,
  cloudrun,
  cdn,
  github,
  pages,
  tunnel,
  other,
}

enum OriginMode {
  proxy,
  redirect,
  unavailable,
}

model Origin {
  url?: string;
  hostHeader?: string;
  kind?: OriginKind;
  mode?: OriginMode;
  retryAfter?: int32;
  pathPrefix?: string;
}

model HealthPolicy {
  paths?: string[];
  timeoutMs?: int32;
  failThreshold?: int32;
  recoverThreshold?: int32;
  staleAfterSeconds?: int32;
}

model HostRoute {
  primary: Origin;
  fallback?: Origin;
  health?: HealthPolicy;
  access?: AccessPolicy;
  retryOnPrimaryError?: boolean;
  websocket?: boolean;
}

model RouterConfig {
  org: string;
  domain: string;
  linearProject?: string;
  gcpProject?: string;
  statusAccess?: AccessPolicy;
  health?: HealthPolicy;
  hosts: Record<HostRoute>;
}
