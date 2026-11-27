import { afterEach, describe, expect, it, vi } from 'vitest';
import { getValidToken } from '../../src/lib/emt-auth';
import { EMT_CONFIG } from '../../src/lib/config';
import { mockEnv, mockKV } from '../helpers/mock-kv';
import { loginResponse } from '../fixtures/emt';

function fetchStub(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getValidToken', () => {
  it('devuelve el token cacheado sin llamar a fetch', async () => {
    const kv = mockKV();
    kv.set(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'cached-token', expiresAt: Date.now() + 3600_000 }),
    );
    const fetchMock = fetchStub(loginResponse());
    vi.stubGlobal('fetch', fetchMock);

    const token = await getValidToken(mockEnv(kv));

    expect(token).toBe('cached-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rehace login si el token cacheado ha expirado', async () => {
    const kv = mockKV();
    kv.set(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'expired-token', expiresAt: Date.now() - 1000 }),
    );
    const fetchMock = fetchStub(loginResponse('fresh-token'));
    vi.stubGlobal('fetch', fetchMock);

    const token = await getValidToken(mockEnv(kv));

    expect(token).toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const stored = JSON.parse((await kv.get(EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN)) as string);
    expect(stored.accessToken).toBe('fresh-token');
    expect(stored.expiresAt).toBeGreaterThan(Date.now());
  });

  it('trata un valor corrupto en KV como miss: re-login y sobrescritura de la clave', async () => {
    const kv = mockKV();
    kv.set(EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN, 'no-es-json{{{');
    const fetchMock = fetchStub(loginResponse('repaired-token'));
    vi.stubGlobal('fetch', fetchMock);

    const token = await getValidToken(mockEnv(kv));

    expect(token).toBe('repaired-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = JSON.parse((await kv.get(EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN)) as string);
    expect(stored.accessToken).toBe('repaired-token');
  });

  it('trata un JSON con forma inesperada como miss (el cast no valida nada)', async () => {
    const kv = mockKV();
    kv.set(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 42, expiresAt: 'mañana' }),
    );
    const fetchMock = fetchStub(loginResponse('shape-token'));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getValidToken(mockEnv(kv))).toBe('shape-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('hace login con X-ClientId y passKey', async () => {
    const kv = mockKV();
    const fetchMock = fetchStub(loginResponse('brand-new'));
    vi.stubGlobal('fetch', fetchMock);

    await getValidToken(mockEnv(kv));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${EMT_CONFIG.BASE_URL}${EMT_CONFIG.ENDPOINTS.LOGIN}`);
    expect((init as RequestInit).headers).toEqual({
      'X-ClientId': 'test-client-id',
      passKey: 'test-pass-key',
    });
  });

  it('lanza error si la respuesta HTTP no es ok', async () => {
    vi.stubGlobal('fetch', fetchStub({ code: '84' }, 405));
    await expect(getValidToken(mockEnv())).rejects.toThrow('EMT login failed: 405');
  });

  it('lanza error si la respuesta no tiene accessToken', async () => {
    vi.stubGlobal('fetch', fetchStub({ code: '00', data: [] }));
    await expect(getValidToken(mockEnv())).rejects.toThrow('Invalid login response format');
  });
});
