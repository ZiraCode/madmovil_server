import type { Env, EMTLoginResponse, CachedToken } from '../types';
import { EMT_CONFIG } from './config';

export async function getValidToken(env: Env): Promise<string> {
  if (!env.EMT_CACHE) {
    throw new Error('KV namespace EMT_CACHE is not configured');
  }

  const cachedTokenStr = await env.EMT_CACHE.get(EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN);

  if (cachedTokenStr) {
    // Valor corrupto o con forma inesperada en KV = miss (re-login): sin esta guarda, un
    // token ilegible tumba toda la familia EMT durante las 24 h de TTL de la clave sin
    // autorrepararse (el 401 de emtFetch nunca llega a producirse). El put de abajo lo
    // sobrescribe en la misma petición
    try {
      const cached = JSON.parse(cachedTokenStr) as Partial<CachedToken>;
      if (
        typeof cached.accessToken === 'string' &&
        typeof cached.expiresAt === 'number' &&
        Date.now() < cached.expiresAt
      ) {
        return cached.accessToken;
      }
    } catch (error) {
      console.warn('Token EMT cacheado ilegible; se fuerza re-login', error);
    }
  }

  const loginUrl = `${EMT_CONFIG.BASE_URL}${EMT_CONFIG.ENDPOINTS.LOGIN}`;

  let response: Response;
  try {
    response = await fetch(loginUrl, {
      method: 'GET',
      headers: {
        'X-ClientId': env.EMT_CLIENT_ID,
        passKey: env.EMT_PASS_KEY,
      },
    });
  } catch (fetchError) {
    console.error('EMT login fetch error:', fetchError);
    throw new Error(
      `Network error: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`,
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unable to read error response');
    console.error(`EMT login failed: ${response.status} ${response.statusText} - ${errorText}`);
    throw new Error(`EMT login failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  let loginResponse: EMTLoginResponse;
  try {
    loginResponse = JSON.parse(await response.text()) as EMTLoginResponse;
  } catch (parseError) {
    console.error('EMT login JSON parse error:', parseError);
    throw new Error(
      `Failed to parse EMT login response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`,
    );
  }

  if (!loginResponse.data?.[0]?.accessToken) {
    throw new Error('Invalid login response format');
  }

  const accessToken = loginResponse.data[0].accessToken;
  const expiresAt = Date.now() + EMT_CONFIG.TOKEN_TTL * 1000;

  const tokenToCache: CachedToken = {
    accessToken,
    expiresAt,
  };

  await env.EMT_CACHE.put(EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN, JSON.stringify(tokenToCache), {
    expirationTtl: EMT_CONFIG.TOKEN_TTL,
  });

  return accessToken;
}
