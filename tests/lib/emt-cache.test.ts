import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAndCacheStops,
  fetchAndCacheLines,
  fetchAndCacheLineDetail,
  fetchAndCacheStopDetail,
  fetchAndCacheCalendar,
  fetchAndCacheLineTimetable,
  fetchAndCacheLineRoute,
  fetchAndCacheIncidents,
  getCachedStops,
  getCachedLines,
  getCachedLineDetail,
  getCachedLineTimetable,
  getCachedLineRoute,
  getCachedIncidents,
  getLineIncidents,
  getArrivals,
  refreshAllCache,
} from '../../src/lib/emt-cache';
import { EMT_CONFIG } from '../../src/lib/config';
import { formatDateYYYYMMDD } from '../../src/lib/date-utils';
import { mockEnv, mockKV } from '../helpers/mock-kv';
import {
  arrivesResponse,
  calendarResponse,
  incidentsResponse,
  lineDetailResponse,
  lineRouteResponse,
  lineRouteEmptyResponse,
  linesResponse,
  loginResponse,
  stopDetailResponse,
  stopsResponse,
} from '../fixtures/emt';

function emtUrl(path: string) {
  return `${EMT_CONFIG.BASE_URL}${path}`;
}

function stubEMT(
  responses: Array<{
    match: (url: string, method: string) => boolean;
    body: unknown;
    status?: number;
  }>,
) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const match = responses.find((r) => r.match(url, method));
    if (!match) {
      return Promise.resolve(new Response('unexpected request', { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(match.body), { status: match.status ?? 200 }),
    );
  });
}

function envWithToken() {
  const kv = mockKV();
  kv.set(
    EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
    JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
  );
  return { env: mockEnv(kv), kv };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('fetchAndCacheStops', () => {
  it('mapea la respuesta EMT a Stop[] con lat/lon correctas y guarda en KV', async () => {
    const { env, kv } = envWithToken();
    const fetchMock = stubEMT([
      {
        match: (url, method) => url.endsWith(EMT_CONFIG.ENDPOINTS.STOPS_LIST) && method === 'POST',
        body: stopsResponse(),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const stops = await fetchAndCacheStops(env);

    expect(stops).toHaveLength(2);
    expect(stops[0]).toEqual({
      stopId: '123',
      name: 'Plaza de Sol',
      coordinates: { latitude: 40.4172, longitude: -3.7038 },
      lines: ['1', '2'],
    });

    const cached = JSON.parse((await kv.get(EMT_CONFIG.CACHE_KEYS.STOPS_ALL)) as string);
    expect(cached).toEqual(stops);
  });
});

describe('fetchAndCacheLines', () => {
  it('consulta la URL con la fecha de hoy y mapea a Line[] con color y grupo', async () => {
    const { env, kv } = envWithToken();
    const today = formatDateYYYYMMDD(new Date());
    const fetchMock = stubEMT([
      {
        match: (url) => url === emtUrl(`${EMT_CONFIG.ENDPOINTS.LINES_INFO}${today}/`),
        body: linesResponse(),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const lines = await fetchAndCacheLines(env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lines[0]).toEqual({
      lineId: '001',
      label: '1',
      nameA: 'Prosperidad',
      nameB: 'Princesa',
      group: 'EMT',
      color: '#53418F',
    });
    expect(kv.has(EMT_CONFIG.CACHE_KEYS.LINES_ALL)).toBe(true);
  });
});

describe('fetchAndCacheLineDetail', () => {
  it('mapea detalle de línea y cachea con clave lineId:fecha', async () => {
    const { env, kv } = envWithToken();
    const fetchMock = stubEMT([
      {
        match: (url) => url.endsWith('/lines/001/info/20260815/'),
        body: lineDetailResponse('001', '1'),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const detail = await fetchAndCacheLineDetail(env, '001', '20260815');

    expect(detail.lineId).toBe('001');
    expect(detail.timeTable).toHaveLength(3);
    expect(kv.has(`${EMT_CONFIG.CACHE_KEYS.LINE_DETAIL}001:20260815`)).toBe(true);
  });
});

describe('fetchAndCacheStopDetail', () => {
  it('mapea detalle de parada con coordenadas invertidas correctamente', async () => {
    const { env } = envWithToken();
    const fetchMock = stubEMT([
      { match: (url) => url.endsWith('/stops/123/detail/'), body: stopDetailResponse('123') },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const detail = await fetchAndCacheStopDetail(env, '123');

    expect(detail.stopId).toBe('123');
    expect(detail.coordinates).toEqual({ latitude: 40.4172, longitude: -3.7038 });
    expect(detail.lines[0].label).toBe('1');
  });

  it('lanza StopNotFoundError si la EMT responde code 90 (parada inexistente)', async () => {
    const { env } = envWithToken();
    const fetchMock = stubEMT([
      {
        match: (url) => url.endsWith('/stops/9999/detail/'),
        body: {
          code: '90',
          description: 'Error managing internal services',
          datetime: '2026-08-15',
          data: [],
        },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAndCacheStopDetail(env, '9999')).rejects.toThrow(
      'no disponible actualmente o inexistente',
    );
  });

  it('lanza EMTServiceUnavailableError si la EMT da code 90 pero la parada existe en el listado (microcaída EMT)', async () => {
    const { env, kv } = envWithToken();
    kv.set(
      EMT_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([
        {
          stopId: '5907',
          name: 'Sol-Sevilla',
          coordinates: { latitude: 1, longitude: 2 },
          lines: ['1'],
        },
      ]),
    );
    const fetchMock = stubEMT([
      {
        match: (url) => url.endsWith('/stops/5907/detail/'),
        body: {
          code: '90',
          description: 'Error managing internal services',
          datetime: '2026-08-15',
          data: [],
        },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAndCacheStopDetail(env, '5907')).rejects.toThrow(
      'no ha podido servir el detalle',
    );
  });
});

describe('fetchAndCacheCalendar', () => {
  it('convierte LA/SA/FE y usa laboral para tipos desconocidos', async () => {
    const { env, kv } = envWithToken();
    const fetchMock = stubEMT([
      { match: (url) => url.endsWith('/calendar/20260101/20261231/'), body: calendarResponse() },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const calendar = await fetchAndCacheCalendar(env, 2026);

    expect(calendar['2026-08-14']).toBe('laboral');
    expect(calendar['2026-08-15']).toBe('sabado');
    expect(calendar['2026-08-16']).toBe('festivo');
    expect(calendar['2026-08-17']).toBe('laboral');
    expect(kv.has(`${EMT_CONFIG.CACHE_KEYS.CALENDAR}2026`)).toBe(true);
  });
});

describe('fetchAndCacheLineTimetable', () => {
  it('deriva del line detail y organiza horarios por tipo de día', async () => {
    const { env, kv } = envWithToken();
    const today = formatDateYYYYMMDD(new Date());
    const fetchMock = stubEMT([
      {
        match: (url) => url.endsWith(`/lines/001/info/${today}/`),
        body: lineDetailResponse('001', '1'),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const timetable = await fetchAndCacheLineTimetable(env, '001');

    expect(timetable.lineId).toBe('001');
    expect(timetable.schedules.laboral).toHaveLength(2);
    expect(timetable.schedules.sabado).toHaveLength(2);
    expect(timetable.schedules.festivo).toHaveLength(2);
    expect(timetable.schedules.laboral![0].StartTime).toBe('07:00');
    expect(kv.has(`${EMT_CONFIG.CACHE_KEYS.LINE_TIMETABLE}001`)).toBe(true);
  });
});

describe('patrón de caché getX', () => {
  it('getCachedStops devuelve del KV sin llamar a fetch', async () => {
    const kv = mockKV();
    const cached = [
      { stopId: '1', name: 'Cacheada', coordinates: { latitude: 1, longitude: 2 }, lines: [] },
    ];
    kv.set(EMT_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(cached));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const stops = await getCachedStops(mockEnv(kv));

    expect(stops).toEqual(cached);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getCachedStops hace fetch si no hay caché', async () => {
    const { env } = envWithToken();
    const fetchMock = stubEMT([
      {
        match: (url, method) => url.endsWith(EMT_CONFIG.ENDPOINTS.STOPS_LIST) && method === 'POST',
        body: stopsResponse(),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const stops = await getCachedStops(env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stops).toHaveLength(2);
  });

  it('getCachedLineDetail devuelve del KV para la fecha exacta', async () => {
    const kv = mockKV();
    const cached = {
      lineId: '001',
      label: '1',
      nameA: 'A',
      nameB: 'B',
      dateRef: '2026-08-15',
      timeTable: [],
    };
    kv.set(`${EMT_CONFIG.CACHE_KEYS.LINE_DETAIL}001:20260815`, JSON.stringify(cached));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const detail = await getCachedLineDetail(mockEnv(kv), '001', '20260815');

    expect(detail).toEqual(cached);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getCachedLineTimetable hace fetch y cachea si no hay caché', async () => {
    const { env, kv } = envWithToken();
    // lines:all sembrado: el pre-check de fetchAndCacheLineDetail valida contra el listado
    // sin gastar un fetch extra (en producción siempre está cacheado)
    kv.set(
      EMT_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify([{ lineId: '001', label: '1', nameA: 'A', nameB: 'B' }]),
    );
    const today = formatDateYYYYMMDD(new Date());
    const fetchMock = stubEMT([
      {
        match: (url) => url.endsWith(`/lines/001/info/${today}/`),
        body: lineDetailResponse('001', '1'),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const timetable = await getCachedLineTimetable(env, '001');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timetable.lineId).toBe('001');
    expect(kv.has(`${EMT_CONFIG.CACHE_KEYS.LINE_TIMETABLE}001`)).toBe(true);
  });
});

describe('refreshAllCache', () => {
  it('refresca stops, lines y calendar en paralelo', async () => {
    const { env } = envWithToken();
    const today = formatDateYYYYMMDD(new Date());
    const year = new Date().getFullYear();
    const fetchMock = stubEMT([
      { match: (url) => url.endsWith(EMT_CONFIG.ENDPOINTS.LOGIN), body: loginResponse() },
      {
        match: (url, method) => url.endsWith(EMT_CONFIG.ENDPOINTS.STOPS_LIST) && method === 'POST',
        body: stopsResponse(),
      },
      {
        match: (url) => url.endsWith(`${EMT_CONFIG.ENDPOINTS.LINES_INFO}${today}/`),
        body: linesResponse(),
      },
      {
        match: (url) => url.endsWith(`/calendar/${year}0101/${year}1231/`),
        body: calendarResponse(),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const result = await refreshAllCache(env, year);

    expect(result).toEqual({ stops: 2, lines: 2, calendar: 4 });
  });
});

describe('getArrivals', () => {
  it('mapea, ordena por tiempo de llegada y convierte 999999 a arrivesInMin null', async () => {
    const { env } = envWithToken();
    const fetchMock = stubEMT([
      {
        match: (url, method) => url.endsWith('/stops/111/arrives/') && method === 'POST',
        body: arrivesResponse(),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const arrivals = await getArrivals(env, '111');

    expect(arrivals).toHaveLength(5);
    expect(arrivals[0]).toEqual({
      line: '45',
      destination: 'REINA VICTORIA',
      estimateArriveSec: 71,
      arrivesInMin: 1,
      distanceM: 363,
      busId: 6746,
      busPosition: { latitude: 40.4131, longitude: -3.6928 },
    });
    expect(arrivals.map((a) => a.estimateArriveSec)).toEqual([71, 74, 620, 950, 999999]);
    expect(arrivals[4].arrivesInMin).toBeNull();
    expect(arrivals[4].estimateArriveSec).toBe(999999);
  });

  it('mapea busPosition desde geometry con coordenadas invertidas y null si falta geometry', async () => {
    const { env } = envWithToken();
    const fetchMock = stubEMT([
      {
        match: (url, method) => url.endsWith('/stops/115/arrives/') && method === 'POST',
        body: arrivesResponse(),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const arrivals = await getArrivals(env, '115');

    expect(arrivals[0].busPosition).toEqual({ latitude: 40.4131, longitude: -3.6928 });
    expect(
      arrivals.find((a) => a.line === '45' && a.estimateArriveSec === 999999)?.busPosition,
    ).toEqual({ latitude: 40.421, longitude: -3.7012 });
    expect(arrivals.find((a) => a.line === '150')?.busPosition).toBeNull();
  });

  it('envía POST con body JSON a la URL con la línea solicitada', async () => {
    const { env } = envWithToken();
    const fetchMock = stubEMT([
      {
        match: (url, method) => url.endsWith('/stops/112/arrives/45/') && method === 'POST',
        body: arrivesResponse(),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await getArrivals(env, '112', '45');

    expect(fetchMock).toHaveBeenCalledWith(
      `${EMT_CONFIG.BASE_URL}${EMT_CONFIG.ENDPOINTS.STOP_ARRIVES}112/arrives/45/`,
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({
      accessToken: 'valid-token',
      'Content-Type': 'application/json',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toMatchObject({
      cultureInfo: 'ES',
      Text_EstimationsRequired_YN: 'Y',
      Text_IncidencesRequired_YN: 'N',
    });
  });

  it('usa la micro-caché en memoria dentro del TTL (un solo fetch)', async () => {
    const { env } = envWithToken();
    const fetchMock = stubEMT([
      {
        match: (url, method) => url.endsWith('/stops/113/arrives/') && method === 'POST',
        body: arrivesResponse(),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await getArrivals(env, '113');
    await getArrivals(env, '113');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('la micro-caché es por binding: envs con KV distinto no comparten estimaciones', async () => {
    const fetchMock = stubEMT([
      {
        match: (url, method) => url.endsWith('/stops/119/arrives/') && method === 'POST',
        body: arrivesResponse(),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await getArrivals(envWithToken().env, '119');
    await getArrivals(envWithToken().env, '119');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('el techo de la micro-caché desaloja a las entradas más antiguas', async () => {
    const { env } = envWithToken();
    const fetchMock = stubEMT([
      {
        match: (url, method) => url.includes('/arrives/') && method === 'POST',
        body: arrivesResponse(),
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const total = EMT_CONFIG.ARRIVALS_CACHE_MAX_ENTRIES + 5;
    for (let i = 1; i <= total; i++) {
      await getArrivals(env, String(1000 + i));
    }
    expect(fetchMock).toHaveBeenCalledTimes(total);

    // la primera consultada (la más antigua) fue desalojada → re-fetch;
    // la última sigue cacheada → no gasta fetch
    await getArrivals(env, '1001');
    expect(fetchMock).toHaveBeenCalledTimes(total + 1);
    await getArrivals(env, String(1000 + total));
    expect(fetchMock).toHaveBeenCalledTimes(total + 1);
  });

  it('devuelve array vacío si la respuesta no trae Arrive', async () => {
    const { env } = envWithToken();
    const fetchMock = stubEMT([
      {
        match: (url, method) => url.endsWith('/stops/114/arrives/') && method === 'POST',
        body: { code: '00', description: 'OK', datetime: '2026-08-15', data: [] },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const arrivals = await getArrivals(env, '114');

    expect(arrivals).toEqual([]);
  });

  it('lanza StopNotFoundError cuando la EMT responde code 80 (parada inexistente)', async () => {
    const { env } = envWithToken();
    const fetchMock = stubEMT([
      {
        match: (url, method) => url.endsWith('/stops/9999/arrives/') && method === 'POST',
        body: {
          code: '80',
          description: [{ ES: 'Parada no disponible actualmente o inexistente' }],
          datetime: '2026-08-15',
          data: [],
        },
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(getArrivals(env, '9999')).rejects.toThrow(
      'no disponible actualmente o inexistente',
    );
  });

  it('sirve la última estimación (stale ≤3 min) si la EMT falla tras caducar el TTL', async () => {
    const { env } = envWithToken();
    vi.stubGlobal(
      'fetch',
      stubEMT([
        {
          match: (url, method) => url.endsWith('/stops/116/arrives/') && method === 'POST',
          body: arrivesResponse(),
        },
      ]),
    );
    const first = await getArrivals(env, '116');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    vi.stubGlobal(
      'fetch',
      stubEMT([
        {
          match: (url, method) => url.endsWith('/stops/116/arrives/') && method === 'POST',
          body: 'overloaded',
          status: 500,
        },
      ]),
    );

    const stale = await getArrivals(env, '116');
    expect(stale).toEqual(first);

    vi.setSystemTime(Date.now() + 4 * 60_000);
    await expect(getArrivals(env, '116')).rejects.toThrow('EMT request failed');
  });

  it('sin caché previa, propaga el error cuando la EMT falla', async () => {
    const { env } = envWithToken();
    vi.stubGlobal(
      'fetch',
      stubEMT([
        {
          match: (url, method) => url.endsWith('/stops/117/arrives/') && method === 'POST',
          body: 'overloaded',
          status: 500,
        },
      ]),
    );

    await expect(getArrivals(env, '117')).rejects.toThrow('EMT request failed');
  });

  it('code 80 con caché stale previa sigue lanzando StopNotFoundError (no sirve stale)', async () => {
    const { env } = envWithToken();
    vi.stubGlobal(
      'fetch',
      stubEMT([
        {
          match: (url, method) => url.endsWith('/stops/118/arrives/') && method === 'POST',
          body: arrivesResponse(),
        },
      ]),
    );
    await getArrivals(env, '118');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    vi.stubGlobal(
      'fetch',
      stubEMT([
        {
          match: (url, method) => url.endsWith('/stops/118/arrives/') && method === 'POST',
          body: {
            code: '80',
            description: [{ ES: 'Parada no disponible actualmente o inexistente' }],
            datetime: '2026-08-15',
            data: [],
          },
        },
      ]),
    );

    await expect(getArrivals(env, '118')).rejects.toThrow(
      'no disponible actualmente o inexistente',
    );
  });
});

describe('fetchAndCacheLineRoute', () => {
  it('mapea la respuesta EMT a LineRoute y guarda en KV con TTL largo', async () => {
    const { env, kv } = envWithToken();
    const fetchMock = stubEMT([
      { match: (url) => url.endsWith('/lines/1/route/'), body: lineRouteResponse('1', '001') },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const route = await fetchAndCacheLineRoute(env, '1');

    expect(route.label).toBe('1');
    expect(route.lineId).toBe('001');
    expect(route.nameA).toBe('PROSPERIDAD');
    expect(route.itinerary.toA.features).toHaveLength(1);
    expect(route.itinerary.toA.features[0].geometry.type).toBe('MultiLineString');
    expect(route.stops.toB.features[0].properties.stopName).toBe('Cristo Rey');
    expect(kv.has(`${EMT_CONFIG.CACHE_KEYS.LINE_ROUTE}1`)).toBe(true);
  });

  it('lanza LineNotFoundError si la EMT devuelve data vacía (label inexistente)', async () => {
    const { env } = envWithToken();
    const fetchMock = stubEMT([
      { match: (url) => url.endsWith('/lines/999/route/'), body: lineRouteEmptyResponse() },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAndCacheLineRoute(env, '999')).rejects.toThrow(
      'No existe ruta para la línea 999',
    );
  });
});

describe('getCachedLineRoute', () => {
  it('devuelve del KV sin llamar a fetch', async () => {
    const kv = mockKV();
    const cached = lineRouteResponse('1', '001').data;
    kv.set(
      `${EMT_CONFIG.CACHE_KEYS.LINE_ROUTE}1`,
      JSON.stringify({
        label: '1',
        lineId: '001',
        nameA: cached.nameSectionA,
        nameB: cached.nameSectionB,
        itinerary: cached.itinerary,
        stops: cached.stops,
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const route = await getCachedLineRoute(mockEnv(kv), '1');

    expect(route.lineId).toBe('001');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hace fetch y cachea si no hay caché', async () => {
    const { env, kv } = envWithToken();
    const fetchMock = stubEMT([
      { match: (url) => url.endsWith('/lines/27/route/'), body: lineRouteResponse('27', '027') },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const route = await getCachedLineRoute(env, '27');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(route.label).toBe('27');
    expect(kv.has(`${EMT_CONFIG.CACHE_KEYS.LINE_ROUTE}27`)).toBe(true);
  });
});

describe('incidencias', () => {
  it('fetchAndCacheIncidents consulta all/, normaliza category string/array y mapea fechas a ISO', async () => {
    const { env, kv } = envWithToken();
    const { response, instants } = incidentsResponse();
    const fetchMock = stubEMT([
      {
        match: (url) => url.endsWith(`${EMT_CONFIG.ENDPOINTS.LINE_INCIDENTS}all/`),
        body: response,
      },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const feed = await fetchAndCacheIncidents(env);

    expect(fetchMock).toHaveBeenCalledWith(
      `${EMT_CONFIG.BASE_URL}${EMT_CONFIG.ENDPOINTS.LINE_INCIDENTS}all/`,
      expect.anything(),
    );
    expect(feed.lastBuildDate).toBe('Mon, 17 Aug 2026 10:53:13 GMT');
    expect(feed.incidents).toHaveLength(4);

    const active = feed.incidents.find((i) => i.id === 'active-5')!;
    expect(active.lines).toEqual(['5']);
    expect(active.startsAt).toBe(new Date(instants.activeStart).toISOString());
    expect(active.endsAt).toBe(new Date(instants.activeEnd).toISOString());
    expect(active.publishedAt).toBe(new Date(instants.published).toISOString());
    expect(active.cause).toBe('08 - Obras');
    expect(active.effect).toBe('05 - Desvío programado');
    expect(active.documentUrl).toBe('http://feeds.emtmadrid.es:8082/docs/obras-cedaceros.pdf');

    const upcoming = feed.incidents.find((i) => i.id === 'upcoming-5-150')!;
    expect(upcoming.lines).toEqual(['5', '150']);
    expect(upcoming.documentUrl).toBe(
      'http://feeds.emtmadrid.es:8082/docs/manifestacion-centro.pdf',
    );

    const noDates = feed.incidents.find((i) => i.id === 'no-dates-N13')!;
    expect(noDates.startsAt).toBeNull();
    expect(noDates.endsAt).toBeNull();
    expect(noDates.publishedAt).toBeNull();
    expect(noDates.documentUrl).toBeNull();

    expect(kv.has(EMT_CONFIG.CACHE_KEYS.INCIDENTS_ALL)).toBe(true);
  });

  it('getCachedIncidents devuelve del KV sin llamar a fetch', async () => {
    const kv = mockKV();
    kv.set(
      EMT_CONFIG.CACHE_KEYS.INCIDENTS_ALL,
      JSON.stringify({ lastBuildDate: 'x', incidents: [] }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const feed = await getCachedIncidents(mockEnv(kv));

    expect(feed.incidents).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getLineIncidents filtra por label, descarta caducadas y ordena por inicio (sin fechas al final)', async () => {
    const { env } = envWithToken();
    const { response } = incidentsResponse();
    vi.stubGlobal(
      'fetch',
      stubEMT([
        {
          match: (url) => url.endsWith(`${EMT_CONFIG.ENDPOINTS.LINE_INCIDENTS}all/`),
          body: response,
        },
      ]),
    );
    await fetchAndCacheIncidents(env);
    vi.unstubAllGlobals();

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const line5 = await getLineIncidents(env, '5');

    expect(line5.incidents.map((i) => i.id)).toEqual(['active-5', 'upcoming-5-150']);
    expect(fetchMock).not.toHaveBeenCalled();

    const all = await getLineIncidents(env, 'all');
    expect(all.incidents.map((i) => i.id)).toEqual(['active-5', 'upcoming-5-150', 'no-dates-N13']);

    const line150 = await getLineIncidents(env, '150');
    expect(line150.incidents.map((i) => i.id)).toEqual(['upcoming-5-150']);

    const none = await getLineIncidents(env, '999');
    expect(none.incidents).toEqual([]);
    expect(none.lastBuildDate).toBe('Mon, 17 Aug 2026 10:53:13 GMT');
  });
});

describe('memoización por isolate de stops:all/lines:all (WeakMap por binding KV)', () => {
  it('getCachedStops no relee KV dentro del TTL', async () => {
    const kv = mockKV();
    kv.set(
      EMT_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([
        { stopId: '1', name: 'Cacheada', coordinates: { latitude: 1, longitude: 2 }, lines: [] },
      ]),
    );
    const env = mockEnv(kv);

    const first = await getCachedStops(env);
    kv.delete(EMT_CONFIG.CACHE_KEYS.STOPS_ALL);
    const second = await getCachedStops(env);

    expect(second).toEqual(first);
    expect(second[0].name).toBe('Cacheada');
  });

  it('envs con KV distinto no comparten memo', async () => {
    const kvA = mockKV();
    kvA.set(
      EMT_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([
        { stopId: 'a', name: 'A', coordinates: { latitude: 1, longitude: 1 }, lines: [] },
      ]),
    );
    const kvB = mockKV();
    kvB.set(
      EMT_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([
        { stopId: 'b', name: 'B', coordinates: { latitude: 2, longitude: 2 }, lines: [] },
      ]),
    );

    expect((await getCachedStops(mockEnv(kvA)))[0].name).toBe('A');
    expect((await getCachedStops(mockEnv(kvB)))[0].name).toBe('B');
  });

  it('getCachedLines memoiza igual y la memo caduca con el TTL', async () => {
    const kv = mockKV();
    kv.set(
      EMT_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify([{ lineId: '001', label: '1', nameA: 'A', nameB: 'B' }]),
    );
    const env = mockEnv(kv);

    expect(await getCachedLines(env)).toHaveLength(1);
    kv.set(
      EMT_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify([{ lineId: '002', label: '2', nameA: 'C', nameB: 'D' }]),
    );
    expect(await getCachedLines(env)).toHaveLength(1); // aún dentro del TTL: valor memoizado

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + EMT_CONFIG.ARTIFACTS_MEMO_TTL_MS + 1000);
    expect((await getCachedLines(env))[0].label).toBe('2'); // TTL vencido: relee KV
  });

  it('single-flight: llamadas concurrentes con el memo frío comparten UNA sola lectura KV', async () => {
    const kv = mockKV();
    kv.set(
      EMT_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([
        { stopId: '1', name: 'A', coordinates: { latitude: 1, longitude: 2 }, lines: [] },
      ]),
    );
    const env = mockEnv(kv);

    const all = await Promise.all([getCachedStops(env), getCachedStops(env), getCachedStops(env)]);

    expect(kv.getCalls.filter((key) => key === EMT_CONFIG.CACHE_KEYS.STOPS_ALL)).toHaveLength(1);
    expect(all[0]).toEqual(all[2]);
  });

  it('un fallo no queda memoizado: la siguiente llamada reintenta el fetch a la EMT', async () => {
    const { env } = envWithToken();
    vi.stubGlobal(
      'fetch',
      stubEMT([
        {
          match: (url, method) =>
            url.endsWith(EMT_CONFIG.ENDPOINTS.STOPS_LIST) && method === 'POST',
          body: 'overloaded',
          status: 500,
        },
      ]),
    );
    await expect(getCachedStops(env)).rejects.toThrow('EMT request failed');

    // sin la expulsión del fallo, el rechazo estaría memoizado 5 min y esto volvería a fallar
    vi.stubGlobal(
      'fetch',
      stubEMT([
        {
          match: (url, method) =>
            url.endsWith(EMT_CONFIG.ENDPOINTS.STOPS_LIST) && method === 'POST',
          body: stopsResponse(),
        },
      ]),
    );
    await expect(getCachedStops(env)).resolves.toHaveLength(
      (stopsResponse().data as unknown[]).length,
    );
  });
});
