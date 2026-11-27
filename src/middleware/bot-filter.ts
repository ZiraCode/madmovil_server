import type { Context, Next } from 'hono';
import type { Env } from '../types';

/**
 * Middleware anti-scraping: rechaza peticiones sin User-Agent en las familias de rutas de datos.
 * Los navegadores y el SSR de madmovil_web siempre envían UA; los fetch de crawler puro no.
 * No aplica a /health (smoke tests), /admin/* (protegido con secret) ni rutas inexistentes.
 */
export async function botFilterMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const userAgent = c.req.header('user-agent');

  if (!userAgent || userAgent.trim() === '') {
    return c.json(
      {
        status: 'error',
        message: 'Petición rechazada: falta la cabecera User-Agent',
        timestamp: new Date().toISOString(),
      },
      403,
    );
  }

  return next();
}
