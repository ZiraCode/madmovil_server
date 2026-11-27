import type { Context, Next } from 'hono';
import type { Env } from '../types';
import { secureEqual } from '../lib/secure-equal';

// Debe coincidir con ratelimits.simple.period de wrangler.toml (ambos bindings usan 60)
const RATE_LIMIT_PERIOD_SEC = 60;

interface RateLimitOptions {
  // Restringe el límite a estos métodos HTTP (p. ej. solo POST para la creación de vaults)
  methods?: string[];
  // Binding del limitador a usar (por defecto el general de 60 req/min)
  binding?: 'RATE_LIMITER' | 'VAULT_CREATE_LIMITER';
  // Bypass del rate limit para el SSR de la propia web: header X-SSR-Key válido → no se
  // toca el binding (unidad no consumida). NUNCA activar en vault ni admin
  ssrBypass?: boolean;
}

/**
 * Middleware de rate limiting vía bindings ratelimit (contador nativo de Cloudflare)
 * La clave es "<contexto>:<ip>" → límite independiente por grupo de rutas e IP
 * Fail-open: si el binding no está configurado, la petición pasa (disponibilidad > protección)
 * @param context Prefijo que identifica el grupo de rutas en la clave del limitador
 */
export function rateLimitMiddleware(context: string, options: RateLimitOptions = {}) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    if (options.ssrBypass && options.binding !== 'VAULT_CREATE_LIMITER' && hasValidSsrKey(c)) {
      return next();
    }

    const limiter = options.binding ? c.env[options.binding] : c.env.RATE_LIMITER;
    if (!limiter) {
      return next();
    }

    if (options.methods && !options.methods.includes(c.req.method)) {
      return next();
    }

    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const { success } = await limiter.limit({ key: `${context}:${ip}` });

    if (!success) {
      return c.json(
        {
          status: 'error',
          message: 'Demasiadas peticiones, inténtalo de nuevo más tarde',
          timestamp: new Date().toISOString(),
        },
        429,
        { 'Retry-After': String(RATE_LIMIT_PERIOD_SEC) },
      );
    }

    return next();
  };
}

/**
 * Bypass del rate limit para el SSR de madmovil_web (W1): sus fetch salen de pocas IPs de
 * colo de Cloudflare y compartían la clave grupo:ip consigo mismos (749 429 en 2 días).
 * Fail-closed: sin SSR_INTERNAL_KEY configurado no hay bypass; header ausente o incorrecto
 * = rate limit normal sin revelar la existencia del bypass. Nunca loguear el header
 */
function hasValidSsrKey(c: Context<{ Bindings: Env }>): boolean {
  const secret = c.env.SSR_INTERNAL_KEY;
  if (!secret) {
    return false;
  }
  const provided = c.req.header('X-SSR-Key');
  return provided !== undefined && secureEqual(provided, secret);
}
