import { afterEach, describe, expect, it, vi } from 'vitest';
import { emtFetch } from '../../src/lib/emt-fetch';
import { EMT_CONFIG } from '../../src/lib/config';
import { loginResponse } from '../fixtures/emt';
import { mockEnv, mockKV } from '../helpers/mock-kv';

const PATH = '/v2/transport/test/';

function envWithValidToken() {
  const kv = mockKV();
  kv.set(
    EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
    JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
  );
  return mockEnv(kv);
}

function fetchStub(body: string, status = 200) {
  return vi.fn().mockResolvedValue(new Response(body, { status }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('emtFetch', () => {
  it('devuelve la respuesta parseada cuando code === "00"', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub(JSON.stringify({ code: '00', description: 'OK', data: [{ id: 1 }] })),
    );

    const result = await emtFetch<{
      code: string;
      description: string;
      data: Array<{ id: number }>;
    }>(envWithValidToken(), PATH);

    expect(result.code).toBe('00');
    expect(result.data).toEqual([{ id: 1 }]);
  });

  it('envía el accessToken en la cabecera', async () => {
    const fetchMock = fetchStub(JSON.stringify({ code: '00', description: 'OK', data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await emtFetch(envWithValidToken(), PATH);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${EMT_CONFIG.BASE_URL}${PATH}`);
    expect((init as RequestInit).headers).toEqual({ accessToken: 'valid-token' });
  });

  it('usa POST cuando se indica', async () => {
    const fetchMock = fetchStub(JSON.stringify({ code: '00', description: 'OK', data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await emtFetch(envWithValidToken(), PATH, 'POST');

    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('lanza error si la respuesta HTTP no es ok', async () => {
    vi.stubGlobal('fetch', fetchStub('boom', 500));

    await expect(emtFetch(envWithValidToken(), PATH)).rejects.toThrow('EMT request failed');
  });

  it('lanza error si el JSON es inválido', async () => {
    vi.stubGlobal('fetch', fetchStub('not-json'));

    await expect(emtFetch(envWithValidToken(), PATH)).rejects.toThrow(
      'Failed to parse EMT response',
    );
  });

  it('lanza error si code !== "00"', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub(JSON.stringify({ code: '84', description: 'Algo fue mal', data: [] })),
    );

    await expect(emtFetch(envWithValidToken(), PATH)).rejects.toThrow(
      'EMT API error: 84 - Algo fue mal',
    );
  });

  it('lanza error de red si fetch falla', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

    await expect(emtFetch(envWithValidToken(), PATH)).rejects.toThrow('Network error');
  });
});

describe('emtFetch: rotación de token en 401', () => {
  const okBody = JSON.stringify({ code: '00', description: 'OK', data: [] });

  it('en 401 borra el token de KV, re-loguea y reintenta una vez', async () => {
    const env = envWithValidToken();
    let firstCall = true;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith(EMT_CONFIG.ENDPOINTS.LOGIN)) {
        return Promise.resolve(
          new Response(JSON.stringify(loginResponse('fresh-token')), { status: 200 }),
        );
      }
      if (firstCall) {
        firstCall = false;
        return Promise.resolve(new Response('unauthorized', { status: 401 }));
      }
      return Promise.resolve(new Response(okBody));
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await emtFetch(env, PATH);

    expect(result.code).toBe('00');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [retryUrl, retryInit] = fetchMock.mock.calls[2];
    expect(retryUrl).toBe(`${EMT_CONFIG.BASE_URL}${PATH}`);
    expect((retryInit as RequestInit).headers).toEqual({ accessToken: 'fresh-token' });
    const kvToken = await env.EMT_CACHE.get(EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN);
    expect(JSON.parse(kvToken as string).accessToken).toBe('fresh-token');
  });

  it('si el 401 persiste tras el reintento, lanza error (sin bucle)', async () => {
    const env = envWithValidToken();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith(EMT_CONFIG.ENDPOINTS.LOGIN)) {
        return Promise.resolve(
          new Response(JSON.stringify(loginResponse('fresh-token')), { status: 200 }),
        );
      }
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(emtFetch(env, PATH)).rejects.toThrow('EMT unauthorized');

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('un 500 no reintenta', async () => {
    const env = envWithValidToken();
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(emtFetch(env, PATH)).rejects.toThrow('EMT request failed');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('emtFetch: gate de path (SSRF)', () => {
  it('rechaza traversal que sale de /v1|/v2/transport/ sin llamar a fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const traversal = `${PATH}../../../../../v1/mobilitylabs/user/login`;
    await expect(emtFetch(envWithValidToken(), traversal)).rejects.toThrow('EMT path inválido');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rechaza URLs absolutas de otro origen', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      emtFetch(envWithValidToken(), 'https://evil.example.com/v2/transport/x/'),
    ).rejects.toThrow('EMT path inválido');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('el mensaje de error HTTP no incluye el cuerpo de la respuesta', async () => {
    vi.stubGlobal('fetch', fetchStub('secret-internal-detail', 500));

    const promise = emtFetch(envWithValidToken(), PATH);

    await expect(promise).rejects.toThrow('EMT request failed');
    await expect(promise).rejects.not.toThrow(/secret-internal-detail/);
  });
});
