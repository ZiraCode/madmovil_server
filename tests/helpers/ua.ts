import type { Hono } from 'hono';
import type { Env } from '../../src/types';

/**
 * Los fetch de Worker/test no llevan User-Agent y el bot-filter los rechazaría.
 * Parchea app.request para inyectar 'user-agent: vitest' por defecto en los tests de rutas;
 * devuelve el request original sin parchear para poder probar el 403 del filtro.
 */
export function patchAppRequestWithUA(app: Hono<{ Bindings: Env }>) {
  const originalRequest = app.request.bind(app);

  app.request = ((
    input: RequestInfo | string,
    init?: RequestInit,
    env?: Env,
    executionCtx?: ExecutionContext,
  ) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('user-agent')) {
      headers.set('user-agent', 'vitest');
    }
    return originalRequest(input, { ...init, headers }, env, executionCtx);
  }) as typeof app.request;

  return originalRequest;
}
