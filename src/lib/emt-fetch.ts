import type { Env } from '../types';
import { EMT_CONFIG } from './config';
import { getValidToken } from './emt-auth';

interface EMTEnvelope {
  code: string;
  description: string;
}

export class EMTApiError extends Error {
  constructor(
    public readonly emtCode: string,
    description: string,
  ) {
    super(`EMT API error: ${emtCode} - ${description}`);
    this.name = 'EMTApiError';
  }
}

class EMTUnauthorizedError extends Error {
  constructor() {
    super('EMT unauthorized');
    this.name = 'EMTUnauthorizedError';
  }
}

function buildEMTUrl(path: string): string {
  const url = new URL(path, EMT_CONFIG.BASE_URL);
  const allowed =
    url.origin === new URL(EMT_CONFIG.BASE_URL).origin &&
    (url.pathname.startsWith('/v1/transport/') || url.pathname.startsWith('/v2/transport/'));
  if (!allowed) {
    throw new Error('EMT path inválido');
  }
  return url.toString();
}

async function emtFetchOnce<T extends EMTEnvelope>(
  env: Env,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const token = await getValidToken(env);
  const url = buildEMTUrl(path);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers:
        body !== undefined
          ? { accessToken: token, 'Content-Type': 'application/json' }
          : { accessToken: token },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(signal && { signal }),
    });
  } catch (error) {
    console.error(`EMT network error (${path}):`, error);
    throw new Error(`Network error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  if (response.status === 401) {
    throw new EMTUnauthorizedError();
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unable to read error response');
    console.error(
      `EMT request failed (${path}): ${response.status} ${response.statusText} - ${errorText}`,
    );
    throw new Error(`EMT request failed (${path}): ${response.status} ${response.statusText}`);
  }

  let parsed: T;
  try {
    parsed = JSON.parse(await response.text()) as T;
  } catch (error) {
    console.error(`EMT parse error (${path}):`, error);
    throw new Error(
      `Failed to parse EMT response: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }

  if (parsed.code !== '00') {
    throw new EMTApiError(parsed.code, parsed.description);
  }

  return parsed;
}

/**
 * Llama a la API EMT con token automático, validación HTTP y del envelope (code === '00')
 * Si la EMT responde 401 (token invalidado en caliente), borra el token cacheado en KV,
 * fuerza re-login y reintenta exactamente una vez
 * @param env Environment con bindings
 * @param path Path del endpoint (se concatena a BASE_URL)
 * @param method Método HTTP (GET por defecto)
 * @param body Body opcional; se envía serializado como JSON
 * @param signal AbortSignal opcional para acotar la duración del fetch
 * @returns Respuesta EMT parseada y validada
 */
export async function emtFetch<T extends EMTEnvelope>(
  env: Env,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await emtFetchOnce(env, path, method, body, signal);
  } catch (error) {
    if (!(error instanceof EMTUnauthorizedError)) {
      throw error;
    }

    console.warn(`EMT 401 con token cacheado (${path}); invalidando token y reintentando una vez`);
    await env.EMT_CACHE.delete(EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN);

    return await emtFetchOnce(env, path, method, body, signal);
  }
}
