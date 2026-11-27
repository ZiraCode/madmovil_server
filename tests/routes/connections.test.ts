import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonBody } from '../helpers/json';
import app from '../../src/index';
import { CRTM_CONFIG, EMT_CONFIG } from '../../src/lib/config';
import { mockEnv, mockKV, mockRateLimiter } from '../helpers/mock-kv';
import { patchAppRequestWithUA } from '../helpers/ua';
import {
  crtmLinesConnectionsFixture,
  crtmStopsConnectionsFixture,
  emtLinesConnectionsFixture,
  emtStopsConnectionsFixture,
} from '../fixtures/connections';

const rawRequest = patchAppRequestWithUA(app);

function seedConnectionsEnv(
  kv = mockKV(),
  opts: { emtStops?: boolean; emtLines?: boolean; crtm?: boolean } = {},
) {
  const { emtStops = true, emtLines = true, crtm = true } = opts;
  if (emtStops)
    kv.set(EMT_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(emtStopsConnectionsFixture()));
  if (emtLines)
    kv.set(EMT_CONFIG.CACHE_KEYS.LINES_ALL, JSON.stringify(emtLinesConnectionsFixture()));
  if (crtm) {
    kv.set(CRTM_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(crtmStopsConnectionsFixture()));
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify({
        count: crtmLinesConnectionsFixture().length,
        lines: crtmLinesConnectionsFixture(),
      }),
    );
  }
  return mockEnv(kv);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /connections/:source/:stopId', () => {
  it('200: transbordos agrupados por red con distancia, dedup de las propias y chips enriquecidos', async () => {
    const res = await app.request('/connections/emt/602', {}, seedConnectionsEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=3600');
    expect(res.headers.get('Vary')).toBe('Origin');

    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.message).toContain('9 línea(s) de transbordo');
    expect(body.data.query).toEqual({
      source: 'emt',
      stopId: '602',
      name: 'Moncloa',
      networks: ['emt'],
    });
    expect(body.data.radiusM).toBe(300);
    expect(body.data.degraded).toBeUndefined();
    expect(body.data.stops.map((s: { id: string }) => s.id)).toEqual([
      '603',
      '06002',
      '4_202',
      '4_203',
      '08888',
      '10_7',
    ]);

    const { transfers } = body.data;
    expect(transfers.count).toBe(9);
    expect(transfers.groups.map((g: { network: string }) => g.network)).toEqual([
      'emt',
      'interurban',
      'metro',
      'urban',
      'ml',
    ]);
    expect(transfers.groups[2].lines.find((l: { label: string }) => l.label === '3')).toMatchObject(
      {
        source: 'crtm',
        network: 'metro',
        id: '4__3_____',
        color: '8EBF42',
      },
    );
  });

  it('origen CRTM: source desambigua los códigos (r_*, 4_*, numéricos de bus)', async () => {
    const res = await app.request('/connections/crtm/4_202', {}, seedConnectionsEnv());
    const body = await jsonBody(res);

    expect(res.status).toBe(200);
    expect(body.data.query).toEqual({
      source: 'crtm',
      stopId: '4_202',
      name: 'MONCLOA',
      networks: ['metro'],
    });
    expect(body.data.transfers.count).toBe(12);
    expect(body.data.transfers.groups.map((g: { network: string }) => g.network)).toEqual([
      'metro',
      'interurban',
      'urban',
      'emt',
      'ml',
    ]);
  });

  it('radius=500 incluye cercanías y EMT lejanos; radius fuera de rango → 400', async () => {
    const env = seedConnectionsEnv();

    const wide = await app.request('/connections/emt/602?radius=500', {}, env);
    const wideBody = await jsonBody(wide);
    expect(wideBody.data.transfers.count).toBe(13);
    expect(wideBody.data.transfers.groups.map((g: { network: string }) => g.network)).toContain(
      'cercanias',
    );

    expect((await app.request('/connections/emt/602?radius=501', {}, env)).status).toBe(400);
    expect((await app.request('/connections/emt/602?radius=0', {}, env)).status).toBe(400);
    expect((await app.request('/connections/emt/602?radius=abc', {}, env)).status).toBe(400);
  });

  it('400: source inválido, stopId EMT no numérico, stopId CRTM con caracteres raros', async () => {
    const env = seedConnectionsEnv();

    expect((await app.request('/connections/foo/602', {}, env)).status).toBe(400);
    expect((await app.request('/connections/emt/abc', {}, env)).status).toBe(400);
    expect((await app.request('/connections/crtm/60%202', {}, env)).status).toBe(400);
  });

  it('404: parada desconocida en la familia pedida', async () => {
    const env = seedConnectionsEnv();

    const emt = await app.request('/connections/emt/9999', {}, env);
    const crtm = await app.request('/connections/crtm/r_99999', {}, env);

    expect(emt.status).toBe(404);
    expect((await jsonBody(emt)).message).toContain('No existe la parada EMT 9999');
    expect(crtm.status).toBe(404);
  });

  it('sin transbordos: 200 distinguible (mensaje y contadores a cero)', async () => {
    const res = await app.request('/connections/crtm/06999?radius=10', {}, seedConnectionsEnv());
    const body = await jsonBody(res);

    expect(res.status).toBe(200);
    expect(body.message).toContain('Sin líneas de transbordo');
    expect(body.data.stops).toEqual([]);
    expect(body.data.transfers.count).toBe(0);
    expect(body.data.transfers.groups).toEqual([]);
  });

  it('degradación CRTM: 200 con degraded sirviendo solo EMT', async () => {
    const env = seedConnectionsEnv(mockKV(), { crtm: false });

    const res = await app.request('/connections/emt/602', {}, env);
    const body = await jsonBody(res);

    expect(res.status).toBe(200);
    expect(body.data.degraded).toEqual(['crtm']);
    expect(body.data.stops.map((s: { id: string }) => s.id)).toEqual(['603']);
    expect(body.data.transfers.groups.map((g: { network: string }) => g.network)).toEqual(['emt']);
  });

  it('degradación EMT (solo falta lines:all): 200 con degraded y refs EMT con id null', async () => {
    const env = seedConnectionsEnv(mockKV(), { emtLines: false });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('EMT down')));

    const res = await app.request('/connections/emt/602', {}, env);
    const body = await jsonBody(res);

    expect(res.status).toBe(200);
    expect(body.data.degraded).toEqual(['emt']);
    const emtGroup = body.data.transfers.groups.find(
      (g: { network: string }) => g.network === 'emt',
    );
    expect(emtGroup.lines.map((l: { id: string | null }) => l.id)).toEqual([null, null]);
  });

  it('degradación EMT con origen CRTM: 200 con degraded sirviendo las redes CRTM', async () => {
    const env = seedConnectionsEnv(mockKV(), { emtStops: false, emtLines: false });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('EMT down')));

    const res = await app.request('/connections/crtm/4_202', {}, env);
    const body = await jsonBody(res);

    expect(res.status).toBe(200);
    expect(body.data.degraded).toEqual(['emt']);
    expect(body.data.transfers.groups.map((g: { network: string }) => g.network)).toEqual([
      'metro',
      'interurban',
      'urban',
      'ml',
    ]);
  });

  it('503 con Retry-After si el listado de paradas de la familia del origen es inaccesible', async () => {
    const env = seedConnectionsEnv(mockKV(), { emtStops: false, emtLines: false });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('EMT down')));

    const res = await app.request('/connections/emt/602', {}, env);

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
  });
});

describe('protecciones de /connections', () => {
  it('bot-filter: rechaza peticiones sin User-Agent', async () => {
    const res = await rawRequest('/connections/emt/602', {}, seedConnectionsEnv());

    expect(res.status).toBe(403);
  });

  it('rate limit grupo connections con clave grupo:ip', async () => {
    const env = seedConnectionsEnv();
    const limiter = mockRateLimiter(1);
    env.RATE_LIMITER = limiter;

    const first = await app.request(
      '/connections/emt/602',
      { headers: { 'cf-connecting-ip': '5.6.7.8' } },
      env,
    );
    const second = await app.request(
      '/connections/emt/602',
      { headers: { 'cf-connecting-ip': '5.6.7.8' } },
      env,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBe('60');
    expect(limiter.calls[0]).toBe('connections:5.6.7.8');
  });
});
