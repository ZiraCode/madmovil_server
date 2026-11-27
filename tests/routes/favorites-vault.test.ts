import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonBody } from '../helpers/json';
import app from '../../src/index';
import type { Env } from '../../src/types';
import { FAVORITES_VAULT_CONFIG } from '../../src/lib/config';
import { VAULT_ALG, vaultKeyFor } from '../../src/lib/favorites-vault';
import type { VaultDoc } from '../../src/lib/favorites-vault';
import { mockEnv, mockKV, mockRateLimiter } from '../helpers/mock-kv';
import { patchAppRequestWithUA } from '../helpers/ua';
import { VAULT_AUTH_HEADER, VAULT_TEST_TOKEN } from '../helpers/vault';

const rawRequest = patchAppRequestWithUA(app);

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const VALID_BODY = {
  payload: 'cGF5bG9hZA==',
  nonce: 'bG9jYQ==',
  turnstileToken: 'XXXX.DUMMY.TOKEN',
};

function envWithTurnstile(kv = mockKV(), overrides: Record<string, unknown> = {}): Env {
  return {
    ...mockEnv(kv),
    TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
    ...overrides,
  } as Env;
}

function siteverifyMock(success = true): ReturnType<typeof vi.fn> {
  return vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ success }), { status: 200 })),
    );
}

function sampleDoc(expSecondsFromNow: number = FAVORITES_VAULT_CONFIG.TTL_SECONDS): VaultDoc {
  return {
    payload: 'c2VlZGVkLXBheWxvYWQ=',
    nonce: 'c2VlZGVkLW5vbmNl',
    alg: VAULT_ALG,
    updatedAt: '2026-08-01T10:00:00Z',
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
  };
}

async function seedVault(kv: ReturnType<typeof mockKV>, doc: VaultDoc): Promise<string> {
  const key = await vaultKeyFor(VAULT_TEST_TOKEN);
  kv.set(key, JSON.stringify(doc));
  return key;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('POST /api/favorites/vault', () => {
  it('crea el vault con Turnstile válido: 201, doc en KV con TTL de 180 días', async () => {
    const kv = mockKV();
    const fetchMock = siteverifyMock(true);
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request(
      '/api/favorites/vault',
      {
        method: 'POST',
        headers: { Authorization: VAULT_AUTH_HEADER },
        body: JSON.stringify(VALID_BODY),
      },
      envWithTurnstile(kv),
    );

    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.updatedAt).toBeTruthy();

    const key = await vaultKeyFor(VAULT_TEST_TOKEN);
    expect(kv.has(key)).toBe(true);
    expect(kv.putCalls.length).toBe(1);
    expect(kv.putCalls[0].options?.expirationTtl).toBe(FAVORITES_VAULT_CONFIG.TTL_SECONDS);
    const doc = JSON.parse((await kv.get(key)) as string) as VaultDoc;
    expect(doc.payload).toBe(VALID_BODY.payload);
    expect(doc.nonce).toBe(VALID_BODY.nonce);
    expect(doc.alg).toBe(VAULT_ALG);
    expect(doc.exp).toBeGreaterThan(
      Math.floor(Date.now() / 1000) + FAVORITES_VAULT_CONFIG.TTL_SECONDS - 60,
    );
  });

  it('llama a siteverify con secret, response y remoteip', async () => {
    const fetchMock = siteverifyMock(true);
    vi.stubGlobal('fetch', fetchMock);

    await app.request(
      '/api/favorites/vault',
      {
        method: 'POST',
        headers: { Authorization: VAULT_AUTH_HEADER, 'cf-connecting-ip': '203.0.113.7' },
        body: JSON.stringify(VALID_BODY),
      },
      envWithTurnstile(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SITEVERIFY_URL);
    const form = init.body as URLSearchParams;
    expect(form.get('secret')).toBe('test-turnstile-secret');
    expect(form.get('response')).toBe(VALID_BODY.turnstileToken);
    expect(form.get('remoteip')).toBe('203.0.113.7');
  });

  it('responde 503 si TURNSTILE_SECRET_KEY no está configurado (fail-closed)', async () => {
    const kv = mockKV();

    const res = await app.request(
      '/api/favorites/vault',
      {
        method: 'POST',
        headers: { Authorization: VAULT_AUTH_HEADER },
        body: JSON.stringify(VALID_BODY),
      },
      mockEnv(kv),
    );

    expect(res.status).toBe(503);
    expect(kv.putCalls.length).toBe(0);
  });

  it('responde 403 si Turnstile rechaza el token', async () => {
    vi.stubGlobal('fetch', siteverifyMock(false));
    const kv = mockKV();

    const res = await app.request(
      '/api/favorites/vault',
      {
        method: 'POST',
        headers: { Authorization: VAULT_AUTH_HEADER },
        body: JSON.stringify(VALID_BODY),
      },
      envWithTurnstile(kv),
    );

    expect(res.status).toBe(403);
    expect(kv.putCalls.length).toBe(0);
  });

  it('responde 503 si siteverify no responde o falla (fail-closed, sin escrituras)', async () => {
    const kv = mockKV();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    const resDown = await app.request(
      '/api/favorites/vault',
      {
        method: 'POST',
        headers: { Authorization: VAULT_AUTH_HEADER },
        body: JSON.stringify(VALID_BODY),
      },
      envWithTurnstile(kv),
    );
    expect(resDown.status).toBe(503);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('server error', { status: 500 })),
    );
    const res500 = await app.request(
      '/api/favorites/vault',
      {
        method: 'POST',
        headers: { Authorization: VAULT_AUTH_HEADER },
        body: JSON.stringify(VALID_BODY),
      },
      envWithTurnstile(kv),
    );
    expect(res500.status).toBe(503);

    expect(kv.putCalls.length).toBe(0);
  });

  it('responde 409 si ya existe un vault para el token', async () => {
    const kv = mockKV();
    await seedVault(kv, sampleDoc());
    vi.stubGlobal('fetch', siteverifyMock(true));

    const res = await app.request(
      '/api/favorites/vault',
      {
        method: 'POST',
        headers: { Authorization: VAULT_AUTH_HEADER },
        body: JSON.stringify(VALID_BODY),
      },
      envWithTurnstile(kv),
    );

    expect(res.status).toBe(409);
  });

  it('rechaza 401 sin Authorization o con token malformado (sin tocar KV)', async () => {
    const kv = mockKV();
    const env = envWithTurnstile(kv);

    const noAuth = await app.request(
      '/api/favorites/vault',
      {
        method: 'POST',
        body: JSON.stringify(VALID_BODY),
      },
      env,
    );
    const badToken = await app.request(
      '/api/favorites/vault',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer no-es-un-token-de-32-bytes' },
        body: JSON.stringify(VALID_BODY),
      },
      env,
    );

    expect(noAuth.status).toBe(401);
    expect(badToken.status).toBe(401);
    expect(kv.putCalls.length).toBe(0);
  });

  it('rechaza 400 con payload/nonce inválidos, turnstileToken ausente o JSON roto', async () => {
    const env = envWithTurnstile();

    const badPayload = await app.request(
      '/api/favorites/vault',
      {
        method: 'POST',
        headers: { Authorization: VAULT_AUTH_HEADER },
        body: JSON.stringify({ payload: '¿no-base64?', nonce: 'bG9jYQ==', turnstileToken: 'X' }),
      },
      env,
    );
    const noNonce = await app.request(
      '/api/favorites/vault',
      {
        method: 'POST',
        headers: { Authorization: VAULT_AUTH_HEADER },
        body: JSON.stringify({ payload: 'cGF5bG9hZA==', turnstileToken: 'X' }),
      },
      env,
    );
    const noTurnstile = await app.request(
      '/api/favorites/vault',
      {
        method: 'POST',
        headers: { Authorization: VAULT_AUTH_HEADER },
        body: JSON.stringify({ payload: 'cGF5bG9hZA==', nonce: 'bG9jYQ==' }),
      },
      env,
    );
    const payloadTooLong = await app.request(
      '/api/favorites/vault',
      {
        method: 'POST',
        headers: { Authorization: VAULT_AUTH_HEADER },
        body: JSON.stringify({
          payload: 'A'.repeat(FAVORITES_VAULT_CONFIG.MAX_PAYLOAD_B64_CHARS + 1),
          nonce: 'bG9jYQ==',
          turnstileToken: 'X',
        }),
      },
      env,
    );
    const brokenJson = await app.request(
      '/api/favorites/vault',
      {
        method: 'POST',
        headers: { Authorization: VAULT_AUTH_HEADER },
        body: '{no-json',
      },
      env,
    );

    expect(badPayload.status).toBe(400);
    expect(noNonce.status).toBe(400);
    expect(noTurnstile.status).toBe(400);
    expect(payloadTooLong.status).toBe(400);
    expect(brokenJson.status).toBe(400);
  });

  it('rechaza 413 si el body supera el tamaño máximo', async () => {
    const res = await app.request(
      '/api/favorites/vault',
      {
        method: 'POST',
        headers: { Authorization: VAULT_AUTH_HEADER },
        body: JSON.stringify({
          payload: 'A'.repeat(FAVORITES_VAULT_CONFIG.MAX_BODY_CHARS),
          nonce: 'bG9jYQ==',
          turnstileToken: 'X',
        }),
      },
      envWithTurnstile(),
    );

    expect(res.status).toBe(413);
  });
});

describe('GET /api/favorites/vault', () => {
  it('responde 404 si no hay vault para el token', async () => {
    const res = await app.request(
      '/api/favorites/vault',
      {
        headers: { Authorization: VAULT_AUTH_HEADER },
      },
      mockEnv(),
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
  });

  it('devuelve payload/nonce/updatedAt del vault', async () => {
    const kv = mockKV();
    const doc = sampleDoc();
    await seedVault(kv, doc);

    const res = await app.request(
      '/api/favorites/vault',
      {
        headers: { Authorization: VAULT_AUTH_HEADER },
      },
      mockEnv(kv),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data).toEqual({ payload: doc.payload, nonce: doc.nonce, updatedAt: doc.updatedAt });
  });

  it('refresca la expiración solo cuando queda menos del umbral', async () => {
    const kv = mockKV();
    const doc = sampleDoc(10 * 24 * 60 * 60);
    const key = await seedVault(kv, doc);

    const first = await app.request(
      '/api/favorites/vault',
      {
        headers: { Authorization: VAULT_AUTH_HEADER },
      },
      mockEnv(kv),
    );
    expect(first.status).toBe(200);
    expect(kv.putCalls.length).toBe(1);
    const touched = JSON.parse((await kv.get(key)) as string) as VaultDoc;
    expect(touched.updatedAt).toBe(doc.updatedAt);
    expect(touched.exp).toBeGreaterThan(
      Math.floor(Date.now() / 1000) + FAVORITES_VAULT_CONFIG.TTL_SECONDS - 60,
    );

    const second = await app.request(
      '/api/favorites/vault',
      {
        headers: { Authorization: VAULT_AUTH_HEADER },
      },
      mockEnv(kv),
    );
    expect(second.status).toBe(200);
    expect(kv.putCalls.length).toBe(1);
  });
});

describe('PUT /api/favorites/vault', () => {
  it('responde 404 si el vault no existe: PUT nunca crea (anti-bypass de Turnstile)', async () => {
    const kv = mockKV();

    const res = await app.request(
      '/api/favorites/vault',
      {
        method: 'PUT',
        headers: { Authorization: VAULT_AUTH_HEADER },
        body: JSON.stringify({ payload: 'bmV3LXBheWxvYWQ=', nonce: 'bmV3LW5vbmNl' }),
      },
      mockEnv(kv),
    );

    expect(res.status).toBe(404);
    const key = await vaultKeyFor(VAULT_TEST_TOKEN);
    expect(kv.has(key)).toBe(false);
    expect(kv.putCalls.length).toBe(0);
  });

  it('actualiza el contenido y refresca updatedAt/exp', async () => {
    const kv = mockKV();
    const key = await seedVault(kv, sampleDoc());

    const res = await app.request(
      '/api/favorites/vault',
      {
        method: 'PUT',
        headers: { Authorization: VAULT_AUTH_HEADER },
        body: JSON.stringify({ payload: 'bmV3LXBheWxvYWQ=', nonce: 'bmV3LW5vbmNl' }),
      },
      mockEnv(kv),
    );

    expect(res.status).toBe(200);
    const doc = JSON.parse((await kv.get(key)) as string) as VaultDoc;
    expect(doc.payload).toBe('bmV3LXBheWxvYWQ=');
    expect(doc.nonce).toBe('bmV3LW5vbmNl');
    expect(doc.updatedAt).not.toBe('2026-08-01T10:00:00Z');
    expect(doc.exp).toBeGreaterThan(
      Math.floor(Date.now() / 1000) + FAVORITES_VAULT_CONFIG.TTL_SECONDS - 60,
    );
  });

  it('rechaza 400/401 igual que POST en validación de body y token', async () => {
    const env = mockEnv();
    await seedVault(mockKV(), sampleDoc());

    const noAuth = await app.request(
      '/api/favorites/vault',
      {
        method: 'PUT',
        body: JSON.stringify({ payload: 'cGF5bG9hZA==', nonce: 'bG9jYQ==' }),
      },
      env,
    );
    const badBody = await app.request(
      '/api/favorites/vault',
      {
        method: 'PUT',
        headers: { Authorization: VAULT_AUTH_HEADER },
        body: JSON.stringify({ payload: '', nonce: 'bG9jYQ==' }),
      },
      env,
    );

    expect(noAuth.status).toBe(401);
    expect(badBody.status).toBe(400);
  });
});

describe('DELETE /api/favorites/vault', () => {
  it('borra el vault existente y responde 404 en repeticiones', async () => {
    const kv = mockKV();
    await seedVault(kv, sampleDoc());

    const first = await app.request(
      '/api/favorites/vault',
      {
        method: 'DELETE',
        headers: { Authorization: VAULT_AUTH_HEADER },
      },
      mockEnv(kv),
    );
    expect(first.status).toBe(200);

    const key = await vaultKeyFor(VAULT_TEST_TOKEN);
    expect(kv.has(key)).toBe(false);

    const second = await app.request(
      '/api/favorites/vault',
      {
        method: 'DELETE',
        headers: { Authorization: VAULT_AUTH_HEADER },
      },
      mockEnv(kv),
    );
    expect(second.status).toBe(404);
  });

  it('responde 404 si no existe nada que borrar', async () => {
    const res = await app.request(
      '/api/favorites/vault',
      {
        method: 'DELETE',
        headers: { Authorization: VAULT_AUTH_HEADER },
      },
      mockEnv(),
    );

    expect(res.status).toBe(404);
  });
});

describe('middleware del vault', () => {
  const SSR_TEST_KEY = 'test-ssr-key-0123456789abcdef0123456789abcdef';

  it('bot-filter: rechaza 403 peticiones sin User-Agent', async () => {
    const res = await rawRequest(
      '/api/favorites/vault',
      {
        headers: { Authorization: VAULT_AUTH_HEADER },
      },
      mockEnv(),
    );

    expect(res.status).toBe(403);
  });

  it('respuestas privadas: Cache-Control private, no-store', async () => {
    const res = await app.request(
      '/api/favorites/vault',
      {
        headers: { Authorization: VAULT_AUTH_HEADER },
      },
      mockEnv(),
    );

    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('VAULT_CREATE_LIMITER aplica solo al POST', async () => {
    const kv = mockKV();
    const createLimiter = mockRateLimiter(2);
    const env = envWithTurnstile(kv, { VAULT_CREATE_LIMITER: createLimiter });
    vi.stubGlobal('fetch', siteverifyMock(true));

    const options = {
      method: 'POST',
      headers: { Authorization: VAULT_AUTH_HEADER },
      body: JSON.stringify(VALID_BODY),
    } as RequestInit;

    const first = await app.request('/api/favorites/vault', options, env);
    const second = await app.request('/api/favorites/vault', options, env);
    const third = await app.request('/api/favorites/vault', options, env);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(third.status).toBe(429);
    expect(third.headers.get('Retry-After')).toBe('60');
    expect(createLimiter.calls.length).toBe(3);

    const get = await app.request(
      '/api/favorites/vault',
      {
        headers: { Authorization: VAULT_AUTH_HEADER },
      },
      env,
    );
    expect(get.status).toBe(200);
  });

  it('rate limit del grupo vault aplica al resto de métodos', async () => {
    const kv = mockKV();
    await seedVault(kv, sampleDoc());
    const env = mockEnv(kv, mockRateLimiter(2));

    const options = {
      headers: { Authorization: VAULT_AUTH_HEADER },
    } as RequestInit;

    const first = await app.request('/api/favorites/vault', options, env);
    const second = await app.request('/api/favorites/vault', options, env);
    const third = await app.request('/api/favorites/vault', options, env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it('W1: X-SSR-Key correcta NO se salta el grupo vault', async () => {
    const kv = mockKV();
    await seedVault(kv, sampleDoc());
    const limiter = mockRateLimiter(2);
    const env = { ...mockEnv(kv, limiter), SSR_INTERNAL_KEY: SSR_TEST_KEY } as Env;

    const options = {
      headers: { Authorization: VAULT_AUTH_HEADER, 'X-SSR-Key': SSR_TEST_KEY },
    } as RequestInit;

    const first = await app.request('/api/favorites/vault', options, env);
    const second = await app.request('/api/favorites/vault', options, env);
    const third = await app.request('/api/favorites/vault', options, env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(limiter.calls.every((key) => key.startsWith('vault'))).toBe(true);
  });

  it('W1: X-SSR-Key correcta NO se salta VAULT_CREATE_LIMITER en el POST', async () => {
    const kv = mockKV();
    const createLimiter = mockRateLimiter(2);
    const env = envWithTurnstile(kv, {
      VAULT_CREATE_LIMITER: createLimiter,
      SSR_INTERNAL_KEY: SSR_TEST_KEY,
    });
    vi.stubGlobal('fetch', siteverifyMock(true));

    const options = {
      method: 'POST',
      headers: { Authorization: VAULT_AUTH_HEADER, 'X-SSR-Key': SSR_TEST_KEY },
      body: JSON.stringify(VALID_BODY),
    } as RequestInit;

    const first = await app.request('/api/favorites/vault', options, env);
    const second = await app.request('/api/favorites/vault', options, env);
    const third = await app.request('/api/favorites/vault', options, env);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(third.status).toBe(429);
    expect(createLimiter.calls.length).toBe(3);
  });
});
