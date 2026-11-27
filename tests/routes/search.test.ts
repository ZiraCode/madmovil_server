import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonBody } from '../helpers/json';
import app from '../../src/index';
import { CRTM_CONFIG, EMT_CONFIG } from '../../src/lib/config';
import { mockEnv, mockKV, mockRateLimiter } from '../helpers/mock-kv';
import { patchAppRequestWithUA } from '../helpers/ua';
import {
  crtmLinesSearchFixture,
  crtmStopsSearchFixture,
  emtLinesSearchFixture,
  emtStopsSearchFixture,
} from '../fixtures/search';

const rawRequest = patchAppRequestWithUA(app);

function seedSearchEnv(kv = mockKV(), opts: { emt?: boolean; crtm?: boolean } = {}) {
  const { emt = true, crtm = true } = opts;
  if (emt) {
    kv.set(EMT_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(emtStopsSearchFixture()));
    kv.set(EMT_CONFIG.CACHE_KEYS.LINES_ALL, JSON.stringify(emtLinesSearchFixture()));
  }
  if (crtm) {
    kv.set(CRTM_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(crtmStopsSearchFixture()));
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify({ count: crtmLinesSearchFixture().length, lines: crtmLinesSearchFixture() }),
    );
  }
  return mockEnv(kv);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /search', () => {
  it('mezcla líneas de todas las redes: C10 → línea de Cercanías con datos para el chip', async () => {
    const res = await app.request('/search?q=C10', {}, seedSearchEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=3600');
    expect(res.headers.get('Vary')).toBe('Origin');
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.lines.count).toBe(1);
    expect(body.data.lines.results[0]).toMatchObject({
      type: 'line',
      source: 'crtm',
      network: 'cercanias',
      label: 'C10',
      id: '10T_C10',
      color: 'C4D600',
    });
    // las paradas NO se buscan por las líneas que las sirven (C10 tiene 20 estaciones):
    // el resultado de parada para una query de línea es simplemente vacío
    expect(body.data.stops.count).toBe(0);
  });

  it('query de texto: paradas de EMT y CRTM en la misma respuesta con el ranking global', async () => {
    const res = await app.request('/search?q=sol', {}, seedSearchEnv());
    const body = await jsonBody(res);

    expect(body.data.stops.results[0]).toMatchObject({
      id: '4_12',
      source: 'crtm',
      match: 'name-exact',
      networks: ['metro'],
    });
    expect(body.data.stops.results[1]).toMatchObject({
      id: '5001',
      source: 'emt',
      match: 'name-prefix',
      networks: ['emt'],
    });
  });

  it('query numérica: código exacto y frontera de dígitos (sin 16200)', async () => {
    const res = await app.request('/search?q=62', {}, seedSearchEnv());
    const body = await jsonBody(res);

    expect(body.data.stops.count).toBe(2);
    expect(body.data.stops.results.map((s: { id: string }) => s.id)).toEqual(['62', '06165']);
  });

  it('lines/stops recortan sin perder el total (count vs returned)', async () => {
    const res = await app.request('/search?q=1&lines=2', {}, seedSearchEnv());
    const body = await jsonBody(res);

    // 3 labels exactos + el 10 por prefijo + la ML1 por nombre ("ML1 Las Tablas...")
    expect(body.data.lines.count).toBe(5);
    expect(body.data.lines.returned).toBe(2);
  });

  it('400 sin q, con q vacía y con q demasiado larga', async () => {
    const env = seedSearchEnv();

    const noParam = await app.request('/search', {}, env);
    const blank = await app.request('/search?q=%20%20', {}, env);
    const tooLong = await app.request(`/search?q=${'a'.repeat(61)}`, {}, env);

    expect(noParam.status).toBe(400);
    expect(blank.status).toBe(400);
    expect(tooLong.status).toBe(400);
    expect((await jsonBody(tooLong)).message).toContain('máximo');
  });

  it('400 con lines/stops fuera de rango o no numéricos', async () => {
    const env = seedSearchEnv();

    expect((await app.request('/search?q=sol&lines=0', {}, env)).status).toBe(400);
    expect((await app.request('/search?q=sol&lines=21', {}, env)).status).toBe(400);
    expect((await app.request('/search?q=sol&stops=51', {}, env)).status).toBe(400);
    expect((await app.request('/search?q=sol&stops=abc', {}, env)).status).toBe(400);
  });

  it('degradación parcial CRTM: 200 con degraded y resultados EMT si el pipeline no ha cargado', async () => {
    const env = seedSearchEnv(mockKV(), { crtm: false });

    const res = await app.request('/search?q=sol', {}, env);
    const body = await jsonBody(res);

    expect(res.status).toBe(200);
    expect(body.data.degraded).toEqual(['crtm']);
    expect(body.data.stops.results.some((s: { source: string }) => s.source === 'emt')).toBe(true);
  });

  it('degradación parcial EMT: 200 con degraded y resultados CRTM si la API EMT falla en miss de caché', async () => {
    const env = seedSearchEnv(mockKV(), { emt: false });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('EMT down')));

    const res = await app.request('/search?q=sol', {}, env);
    const body = await jsonBody(res);

    expect(res.status).toBe(200);
    expect(body.data.degraded).toEqual(['emt']);
    expect(body.data.stops.results.some((s: { source: string }) => s.source === 'crtm')).toBe(true);
  });

  it('503 con Retry-After si fallan ambas familias de artefactos', async () => {
    const env = seedSearchEnv(mockKV(), { emt: false, crtm: false });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('EMT down')));

    const res = await app.request('/search?q=sol', {}, env);

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  it('sin resultados: 200 con contadores a cero y mensaje distinguible', async () => {
    const res = await app.request('/search?q=zzzzzz', {}, seedSearchEnv());
    const body = await jsonBody(res);

    expect(res.status).toBe(200);
    expect(body.message).toContain('No se encontraron');
    expect(body.data.lines.count).toBe(0);
    expect(body.data.stops.count).toBe(0);
  });
});

describe('protecciones de /search', () => {
  it('bot-filter: rechaza peticiones sin User-Agent', async () => {
    const res = await rawRequest('/search?q=sol', {}, seedSearchEnv());

    expect(res.status).toBe(403);
  });

  it('rate limit grupo search con clave grupo:ip', async () => {
    const env = seedSearchEnv();
    const limiter = mockRateLimiter(1);
    env.RATE_LIMITER = limiter;

    const first = await app.request(
      '/search?q=sol',
      { headers: { 'cf-connecting-ip': '5.6.7.8' } },
      env,
    );
    const second = await app.request(
      '/search?q=sol',
      { headers: { 'cf-connecting-ip': '5.6.7.8' } },
      env,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBe('60');
  });
});
