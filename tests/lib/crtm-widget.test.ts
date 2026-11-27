import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CRTM_CONFIG } from '../../src/lib/config';
import {
  getWidgetStopTimes,
  isWidgetStopTimesFresh,
  resolveWidgetStopCodes,
  __resetWidgetCache,
} from '../../src/lib/crtm-widget';
import {
  CRTM_TEST_NOW,
  crtmWidgetGetStopsFixture,
  crtmWidgetStopTimesFixture,
} from '../fixtures/crtm';
import { mockEnv, mockKV } from '../helpers/mock-kv';
import type { KVNamespace } from '@cloudflare/workers-types';
import type { MockKV } from '../helpers/mock-kv';

function widgetFetchMock(nowMs = CRTM_TEST_NOW, opts: { frozen?: boolean } = {}) {
  const times = crtmWidgetStopTimesFixture(nowMs, opts);
  const stops = crtmWidgetGetStopsFixture();
  const fetchMock = vi.fn().mockImplementation((url: string | URL) => {
    const u = new URL(String(url));
    const codStop = u.searchParams.get('codStop');
    if (u.pathname.endsWith(CRTM_CONFIG.WIDGET.GET_STOP_TIMES)) {
      return Promise.resolve(
        new Response(JSON.stringify(times[codStop ?? ''] ?? {}), { status: 200 }),
      );
    }
    if (u.pathname.endsWith(CRTM_CONFIG.WIDGET.GET_STOP)) {
      return Promise.resolve(
        new Response(JSON.stringify(stops[codStop ?? ''] ?? { stops: {} }), { status: 200 }),
      );
    }
    return Promise.reject(new Error(`URL inesperada: ${u}`));
  });
  return fetchMock;
}

describe('crtm-widget: parse de GetStopsTimes', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date(CRTM_TEST_NOW));
    __resetWidgetCache();
  });

  afterEach(() => {
    __resetWidgetCache();
    vi.unstubAllGlobals();
  });

  it('parsea el tablón de bus: routeId/network/dest/dir/realtime por línea, orden por llegada', async () => {
    vi.stubGlobal('fetch', widgetFetchMock());

    const snapshot = await getWidgetStopTimes('8_09568');

    expect(snapshot).not.toBeNull();
    expect(snapshot!.stopName).toBe('Pº EXTREMADURA - AV. PORTUGAL');
    expect(snapshot!.actualDateMs).toBe(CRTM_TEST_NOW);
    expect(snapshot!.arrivals.map((a) => a.routeId)).toEqual([
      '8__421___',
      '8__421___',
      '8__211___',
      '8__421___',
      '8__421___',
    ]);
    // ordenadas por llegada (la ya efectiva de -60 s va primera; la ruta la filtra después)
    expect(snapshot!.arrivals[0].timeMs).toBe(CRTM_TEST_NOW - 60_000);
    expect(snapshot!.arrivals[1]).toMatchObject({
      routeId: '8__421___',
      line: '421',
      network: 'interurban',
      dir: 0,
      dest: 'INTERCAMBIADOR DE MONCLOA',
      realtime: true,
    });
    // direction 2 del widget → dir 1 GTFS, con vehículo
    expect(snapshot!.arrivals[3]).toMatchObject({
      dir: 1,
      dest: 'BOADILLA DEL MONTE',
      vehicle: 'E-1234',
      realtime: true,
    });
    // SAEStatus false de su línea → hora teórica
    expect(snapshot!.arrivals[2]).toMatchObject({ line: '211', realtime: false });
    // línea sin entrada en linesStatus no marca teórica
    expect(snapshot!.arrivals[1].lineName).toBe('421-MADRID (Moncloa)-BOADILLA DEL MONTE');
  });

  it('colección de 1 elemento como objeto suelto (quirk SOAP→JSON): 10_5 y 9_08712', async () => {
    vi.stubGlobal('fetch', widgetFetchMock());

    const ml = await getWidgetStopTimes('10_5');
    expect(ml!.arrivals).toHaveLength(1);
    expect(ml!.arrivals[0]).toMatchObject({
      routeId: '10__ML2___',
      line: 'ML2',
      network: 'ml',
      dir: 1,
      realtime: true,
    });

    const urban = await getWidgetStopTimes('9_08712');
    expect(urban!.arrivals).toHaveLength(1);
    expect(urban!.arrivals[0]).toMatchObject({
      routeId: '9__1__013_',
      network: 'urban',
      dest: 'ESTACIÓN DE ALCORCÓN',
    });
  });

  it('{} en la raíz = parada sin servicio: snapshot válido y vacío (no error)', async () => {
    vi.stubGlobal('fetch', widgetFetchMock());

    const snapshot = await getWidgetStopTimes('8_09999'); // sin entrada en el fixture → {}

    expect(snapshot).not.toBeNull();
    expect(snapshot!.arrivals).toEqual([]);
    expect(snapshot!.actualDateMs).toBeNull();
    expect(isWidgetStopTimesFresh(snapshot!)).toBe(true);
  });

  it('body con {"error": ...} o items sin codLine/time → null o skip sin romper', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string | URL) => {
        const u = new URL(String(url));
        const codStop = u.searchParams.get('codStop');
        if (codStop === '8_ERR001') {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'ERR', message: 'boom' }), { status: 200 }),
          );
        }
        if (codStop === '8_BAD002') {
          const now = new Date(CRTM_TEST_NOW).toISOString();
          return Promise.resolve(
            new Response(
              JSON.stringify({
                stopTimes: {
                  actualDate: now,
                  times: {
                    Time: [
                      { direction: 1, time: now },
                      {
                        line: { codLine: '8__421___', shortDescription: '421' },
                        direction: 1,
                        time: 'no-una-fecha',
                      },
                      {
                        line: { codLine: '8__421___', shortDescription: '421' },
                        direction: 3,
                        time: now,
                      },
                    ],
                  },
                },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.reject(new Error(`URL inesperada: ${u}`));
      }),
    );

    expect(await getWidgetStopTimes('8_ERR001')).toBeNull();

    const bad = await getWidgetStopTimes('8_BAD002');
    expect(bad!.arrivals).toHaveLength(1); // sin codLine y sin time parseable se descartan; direction 3 → dir null
    expect(bad!.arrivals[0].dir).toBeNull();
  });

  it('caché por isolate con TTL: segunda llamada dentro del TTL no repite fetch', async () => {
    const fetchMock = widgetFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    await getWidgetStopTimes('8_09568');
    await getWidgetStopTimes('8_09568');

    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(CRTM_TEST_NOW + CRTM_CONFIG.WIDGET.CACHE_TTL_MS + 1000));
    await getWidgetStopTimes('8_09568');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetch caído → null sin caché previa; con caché reciente → stale-serve', async () => {
    const fetchMock = widgetFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    await getWidgetStopTimes('8_09568');

    fetchMock.mockRejectedValue(new TypeError('network down'));
    vi.setSystemTime(new Date(CRTM_TEST_NOW + CRTM_CONFIG.WIDGET.CACHE_TTL_MS + 1000));
    const stale = await getWidgetStopTimes('8_09568'); // < STALE_MAX_AGE_MS → sirve la instantánea
    expect(stale).not.toBeNull();
    expect(stale!.arrivals.length).toBeGreaterThan(0);

    vi.setSystemTime(new Date(CRTM_TEST_NOW + CRTM_CONFIG.WIDGET.STALE_MAX_AGE_MS + 60_000));
    expect(await getWidgetStopTimes('8_09568')).toBeNull();
  });

  it('caché negativa: un fallo se recuerda CACHE_TTL_MS (null inmediato, sin repetir fetch)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getWidgetStopTimes('8_09568')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(await getWidgetStopTimes('8_09568')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(CRTM_TEST_NOW + CRTM_CONFIG.WIDGET.CACHE_TTL_MS + 1000));
    expect(await getWidgetStopTimes('8_09568')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('un éxito limpia la marca de fallo (y se recoloca si vuelve a fallar)', async () => {
    const times = crtmWidgetStopTimesFixture(CRTM_TEST_NOW);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(new Response(JSON.stringify(times['8_09568']), { status: 200 }))
      .mockRejectedValue(new TypeError('network down'));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getWidgetStopTimes('8_09568')).toBeNull();
    vi.setSystemTime(new Date(CRTM_TEST_NOW + CRTM_CONFIG.WIDGET.CACHE_TTL_MS + 1000));
    expect(await getWidgetStopTimes('8_09568')).not.toBeNull();

    // ya sin stale utilizable: si el éxito no hubiera limpiado la marca, este fallo no se
    // recordaría y la 4ª llamada volvería a pagar el fetch
    vi.setSystemTime(
      new Date(
        CRTM_TEST_NOW +
          2 * CRTM_CONFIG.WIDGET.CACHE_TTL_MS +
          CRTM_CONFIG.WIDGET.STALE_MAX_AGE_MS +
          60_000,
      ),
    );
    expect(await getWidgetStopTimes('8_09568')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(await getWidgetStopTimes('8_09568')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('actualDate congelada >10 min → snapshot no fresca (anti-bandazos, igual que Renfe)', async () => {
    vi.stubGlobal('fetch', widgetFetchMock(CRTM_TEST_NOW, { frozen: true }));

    const snapshot = await getWidgetStopTimes('8_09568');

    expect(snapshot).not.toBeNull();
    expect(isWidgetStopTimesFresh(snapshot!)).toBe(false);
  });
});

describe('crtm-widget: resolveWidgetStopCodes', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date(CRTM_TEST_NOW));
    __resetWidgetCache();
  });

  afterEach(() => {
    __resetWidgetCache();
    vi.unstubAllGlobals();
  });

  it('metro/ML: el código público ES el codStop del widget (sin resolución ni fetch)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const kv = mockKV();
    const env = mockEnv(kv);

    await expect(resolveWidgetStopCodes(env, '4_263')).resolves.toEqual(['4_263']);
    await expect(resolveWidgetStopCodes(env, '10_5')).resolves.toEqual(['10_5']);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(kv.putCalls).toHaveLength(0);
  });

  it('bus 8_: resuelve con GetStops.php, cachea en KV con TTL 30d y memoiza por isolate', async () => {
    const fetchMock = widgetFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const kv = mockKV();
    const env = mockEnv(kv);

    await expect(resolveWidgetStopCodes(env, '09568')).resolves.toEqual(['8_09568']);

    expect(fetchMock).toHaveBeenCalledTimes(2); // 8_ existe, 9_ no: ambas consultadas en paralelo
    expect(kv.putCalls).toHaveLength(1);
    expect(kv.putCalls[0]).toMatchObject({
      key: `${CRTM_CONFIG.WIDGET.STOP_CODE_CACHE_PREFIX}09568`,
      options: { expirationTtl: CRTM_CONFIG.WIDGET.STOP_CODE_TTL },
    });
    expect(JSON.parse(kv.putCalls[0].value)).toEqual({ codStops: ['8_09568'] });

    await resolveWidgetStopCodes(env, '09568'); // memo: sin fetch ni escrituras nuevas
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(kv.putCalls).toHaveLength(1);
  });

  it('bus 9_: la 08712 (urbana) vive como 9_ en el widget', async () => {
    vi.stubGlobal('fetch', widgetFetchMock());
    const kv = mockKV();

    await expect(resolveWidgetStopCodes(mockEnv(kv), '08712')).resolves.toEqual(['9_08712']);
  });

  it('parada sin modo resuelto → [] cacheado con TTL corto (reintento diario)', async () => {
    vi.stubGlobal('fetch', widgetFetchMock());
    const kv = mockKV();

    await expect(resolveWidgetStopCodes(mockEnv(kv), '09999')).resolves.toEqual([]);

    expect(kv.putCalls).toHaveLength(1);
    expect(kv.putCalls[0].options).toMatchObject({
      expirationTtl: CRTM_CONFIG.WIDGET.STOP_CODE_NONE_TTL,
    });
  });

  it('fallo transitorio de GetStops → [] SIN cachear "none"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    const kv = mockKV();

    await expect(resolveWidgetStopCodes(mockEnv(kv), '09568')).resolves.toEqual([]);

    expect(kv.putCalls).toHaveLength(0);
  });

  it('mapeo cacheado en KV se usa sin fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const kv = mockKV();
    kv.set(
      `${CRTM_CONFIG.WIDGET.STOP_CODE_CACHE_PREFIX}09568`,
      JSON.stringify({ codStops: ['8_09568'] }),
    );
    const env = mockEnv(kv);

    await expect(resolveWidgetStopCodes(env, '09568')).resolves.toEqual(['8_09568']);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(kv.putCalls).toHaveLength(0);
  });

  it('código con formato no reconocido → []', async () => {
    const kv = mockKV() as KVNamespace & MockKV;

    await expect(resolveWidgetStopCodes(mockEnv(kv), 'r_18000')).resolves.toEqual([]);
    await expect(resolveWidgetStopCodes(mockEnv(kv), 'abc')).resolves.toEqual([]);
  });
});
