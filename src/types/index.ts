export interface Env {
  EMT_CACHE: KVNamespace;
  CRTM_SHAPES: R2Bucket;
  RATE_LIMITER: RateLimit;
  VAULT_CREATE_LIMITER?: RateLimit; // opcional: rate-limit es fail-open sin él (solo lo inyecta el POST del vault)
  EMT_CLIENT_ID: string; // Secret
  EMT_PASS_KEY: string; // Secret
  ADMIN_SECRET: string; // Secret
  TURNSTILE_SECRET_KEY?: string; // Secret opcional (verificación server-side de Turnstile al crear vaults; fail-closed 503 si falta)
  SSR_INTERNAL_KEY?: string; // Secret (bypass del rate limit para el SSR de la propia web vía header X-SSR-Key; fail-closed si falta)
}

export interface HealthResponse {
  status: 'ok' | 'error';
  timestamp: string;
  version: string;
}

export interface EMTLoginResponse {
  data: Array<{
    accessToken: string;
  }>;
}

export interface CachedToken {
  accessToken: string;
  expiresAt: number;
}
