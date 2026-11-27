import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonBody } from '../helpers/json';
import app from '../../src/index';
import { CRTM_CONFIG, EMT_CONFIG } from '../../src/lib/config';
import { mockEnv, mockKV } from '../helpers/mock-kv';
import { patchAppRequestWithUA } from '../helpers/ua';
import {
  crtmLinesSearchFixture,
  crtmStopsSearchFixture,
  emtLinesSearchFixture,
  emtStopsSearchFixture,
} from '../fixtures/search';

const rawRequest = patchAppRequestWithUA(app);

function seedCatalogEnv(
  kv = mockKV(),
  opts: { emt?: boolean; crtm?: boolean; meta?: boolean } = {},
) {
  const { emt = true, crtm = true, meta = false } = opts;
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
  if (meta) {
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.META,
      JSON.stringify({ generatedAt: '2026-10-27T10:45:58.666Z', versions: {}, counts: {} }),
    );
  }
  return mockEnv(kv);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /catalog', () => {
  it('sirve labels EMT, pares label/routeId CRTM y códigos de parada de ambas familias', async () => {
    const res = await app.request('/catalog', {}, seedCatalogEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=3600');
    expect(res.headers.get('Vary')).toBe('Origin');
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.emt.lines).toEqual(['1', '51', '10']);
    expect(body.data.emt.stops).toEqual(['62', '456', '5001']);
    expect(body.data.crtm.lines).toHaveLength(6);
    expect(body.data.crtm.lines).toContainEqual({ label: 'C10', routeId: '10T_C10' });
    expect(body.data.crtm.stops).toEqual(crtmStopsSearchFixture().map((s) => s.code));
    expect(body.data.crtm.stops).toContain('4_12');
    expect(body.data.crtm.stops).toContain('r_18000');
    expect(body.data.degraded).toBeUndefined();
    expect(body.data.crtm.generatedAt).toBeNull();
    expect(body.message).toContain('9 línea(s)');
    expect(body.message).toContain('10 parada(s)');
  });

  it('crtm.generatedAt llega desde crtm:meta (lastmod de los sitemaps CRTM)', async () => {
    const res = await app.request('/catalog', {}, seedCatalogEnv(mockKV(), { meta: true }));
    const body = await jsonBody(res);

    expect(body.data.crtm.generatedAt).toBe('2026-10-27T10:45:58.666Z');
  });

  it('degradación parcial CRTM: 200 con degraded y catálogo EMT si el pipeline no ha cargado', async () => {
    const res = await app.request('/catalog', {}, seedCatalogEnv(mockKV(), { crtm: false }));
    const body = await jsonBody(res);

    expect(res.status).toBe(200);
    expect(body.data.degraded).toEqual(['crtm']);
    expect(body.data.emt.lines).toHaveLength(3);
    expect(body.data.crtm.lines).toEqual([]);
    expect(body.data.crtm.stops).toEqual([]);
  });

  it('degradación parcial EMT: 200 con degraded y catálogo CRTM si la API EMT falla en miss de caché', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('EMT down')));
    const res = await app.request('/catalog', {}, seedCatalogEnv(mockKV(), { emt: false }));
    const body = await jsonBody(res);

    expect(res.status).toBe(200);
    expect(body.data.degraded).toEqual(['emt']);
    expect(body.data.crtm.lines).toHaveLength(6);
    expect(body.data.emt.stops).toEqual([]);
  });

  it('503 + Retry-After si fallan ambas familias', async () => {
    const res = await app.request(
      '/catalog',
      {},
      seedCatalogEnv(mockKV(), { emt: false, crtm: false }),
    );

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
  });

  it('bot-filter: sin User-Agent → 403 sin tocar los artefactos', async () => {
    const res = await rawRequest('/catalog', {}, seedCatalogEnv());

    expect(res.status).toBe(403);
  });
});
