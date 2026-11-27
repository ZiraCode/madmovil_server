import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonBody } from '../helpers/json';
import app from '../../src/index';
import type { Stop } from '../../src/types/emt-data';
import { EMT_CONFIG, CRTM_CONFIG } from '../../src/lib/config';
import { formatDateYYYYMMDD } from '../../src/lib/date-utils';
import { crtmMetaFixture } from '../fixtures/crtm';
import { mockEnv, mockKV, mockRateLimiter } from '../helpers/mock-kv';
import { patchAppRequestWithUA } from '../helpers/ua';
import {
  calendarResponse,
  incidentsResponse,
  incidentsEmptyResponse,
  lineDetailResponse,
  linesResponse,
  lineRouteResponse,
  lineRouteEmptyResponse,
  stopsResponse,
  stopDetailResponse,
  arrivesResponse,
} from '../fixtures/emt';

const rawRequest = patchAppRequestWithUA(app);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /health', () => {
  it('responde 200 con status ok', async () => {
    const res = await app.request('/health', {}, mockEnv());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('ok');
  });
});

describe('bot-filter (403 sin User-Agent)', () => {
  it('rechaza /stops/* sin User-Agent', async () => {
    const res = await rawRequest('/stops/search?name=gran', {}, mockEnv());

    expect(res.status).toBe(403);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
  });

  it('sirve robots.txt cerrado', async () => {
    const res = await rawRequest('/robots.txt', {}, mockEnv());

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Disallow: /');
  });

  it('rechaza /lines/* y /crtm/* sin User-Agent', async () => {
    const linesRes = await rawRequest('/lines', {}, mockEnv());
    const crtmRes = await rawRequest('/crtm/lines', {}, mockEnv());

    expect(linesRes.status).toBe(403);
    expect(crtmRes.status).toBe(403);
  });

  it('rechaza User-Agent vacío', async () => {
    const res = await rawRequest(
      '/stops/search?name=gran',
      { headers: { 'user-agent': '  ' } },
      mockEnv(),
    );

    expect(res.status).toBe(403);
  });

  it('deja pasar /stops/* con cualquier User-Agent', async () => {
    const res = await app.request(
      '/stops/search?name=gran',
      { headers: { 'user-agent': 'madmovil-web-ssr/1.0' } },
      envWithStops(),
    );

    expect(res.status).toBe(200);
  });

  it('no filtra /health (smoke CI)', async () => {
    const healthRes = await rawRequest('/health', {}, mockEnv());

    expect(healthRes.status).toBe(200);
  });
});

describe('host workers.dev (solo /health)', () => {
  it('rechaza también el FQDN con punto final (trailing dot)', async () => {
    const res = await app.request(
      'https://madmovil-server.yagorat.workers.dev./stops/search?name=gran',
      { headers: { 'user-agent': 'vitest' } },
      mockEnv(),
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
  });
  it('devuelve 404 en rutas de datos', async () => {
    const res = await app.request(
      'https://madmovil-server.yagorat.workers.dev/stops/search?name=gran',
      { headers: { 'user-agent': 'vitest' } },
      mockEnv(),
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
    expect(body.message).toContain('api.madmovil.es');
  });

  it('sirve /health en workers.dev (smoke CI)', async () => {
    const res = await app.request(
      'https://madmovil-server.yagorat.workers.dev/health',
      {},
      mockEnv(),
    );

    expect(res.status).toBe(200);
  });

  it('no afecta al dominio propio ni a localhost', async () => {
    const apiRes = await app.request(
      'https://api.madmovil.es/stops/search?name=gran',
      { headers: { 'user-agent': 'vitest' } },
      envWithStops(),
    );
    const healthRes = await rawRequest('/health', {}, mockEnv());

    expect(apiRes.status).toBe(200);
    expect(healthRes.status).toBe(200);
  });
});

describe('CORS', () => {
  it('no envía ACAO para orígenes desconocidos', async () => {
    const res = await app.request(
      '/health',
      { headers: { Origin: 'https://evil.example' } },
      mockEnv(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('envía ACAO para localhost', async () => {
    const res = await app.request(
      '/health',
      { headers: { Origin: 'http://localhost:3000' } },
      mockEnv(),
    );

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
  });

  it('no envía ACAO para madmovil.com (dominio aún no controlado)', async () => {
    const res = await app.request(
      '/health',
      { headers: { Origin: 'https://madmovil.com' } },
      mockEnv(),
    );

    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('permite PUT y Authorization en preflight (vault de favoritos)', async () => {
    const res = await app.request(
      '/api/favorites/vault',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'authorization',
        },
      },
      mockEnv(),
    );

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
});

describe('rutas retiradas', () => {
  it('/cache-test/*, /auth-test, /api/public/test y /api/user/* (Supabase, F3) responden 404', async () => {
    for (const path of [
      '/cache-test/stops',
      '/cache-test/line-detail/1',
      '/auth-test',
      '/api/public/test',
      '/api/user/me',
      '/api/user/favorites',
      '/api/user/favorites/123',
      '/api/user/account',
    ]) {
      const res = await app.request(path, { headers: { 'user-agent': 'vitest' } }, mockEnv());

      expect(res.status).toBe(404);
    }
  });
});

function envWithStops() {
  const kv = mockKV();
  const stops: Stop[] = [
    {
      stopId: '123',
      name: 'Plaza de España',
      coordinates: { latitude: 1, longitude: 2 },
      lines: ['1'],
    },
    { stopId: '456', name: 'Gran Vía', coordinates: { latitude: 3, longitude: 4 }, lines: ['2'] },
  ];
  kv.set(EMT_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(stops));
  return mockEnv(kv);
}

function envWithLines() {
  const kv = mockKV();
  const lines = [
    { lineId: '001', label: '1', nameA: 'Prosperidad', nameB: 'Princesa' },
    { lineId: '068', label: '68', nameA: 'Mirasierra', nameB: 'Atocha' },
  ];
  kv.set(EMT_CONFIG.CACHE_KEYS.LINES_ALL, JSON.stringify(lines));
  return mockEnv(kv);
}

describe('GET /stops/search', () => {
  it('devuelve 400 si no hay parámetros', async () => {
    const res = await app.request('/stops/search', {}, envWithStops());

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
  });

  it('busca por stopId exacto', async () => {
    const res = await app.request('/stops/search?stopId=123', {}, envWithStops());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(1);
    expect(body.data.stops[0].name).toBe('Plaza de España');
  });

  it('busca por nombre normalizado sin acentos', async () => {
    const res = await app.request('/stops/search?name=espana', {}, envWithStops());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(1);
    expect(body.data.stops[0].stopId).toBe('123');
  });

  it('devuelve count 0 si no hay coincidencias', async () => {
    const res = await app.request('/stops/search?name= nonexistent', {}, envWithStops());

    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.count).toBe(0);
  });

  it('devuelve 400 si name normaliza a vacío (solo símbolos no matchea todo)', async () => {
    const res = await app.request('/stops/search?name=%21%21%21', {}, envWithStops());

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
  });

  it('limit recorta el listado: count total y returned acotado', async () => {
    const res = await app.request('/stops/search?name=a&limit=1', {}, envWithStops());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(2);
    expect(body.data.returned).toBe(1);
    expect(body.data.stops).toHaveLength(1);
  });

  it('limit fuera de rango devuelve 400', async () => {
    const res = await app.request('/stops/search?name=a&limit=101', {}, envWithStops());

    expect(res.status).toBe(400);
  });
});

describe('Contrato global y fixes de revision', () => {
  it('404 de ruta inexistente con envelope JSON (app.notFound)', async () => {
    const res = await app.request('/ruta-inexistente', {}, mockEnv());

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
    expect(body.message).toBe('Ruta no encontrada');
  });

  it('/lines/detail de linea inexistente: 404 sin gastar cuota EMT', async () => {
    const res = await app.request(
      '/lines/detail/999',
      { headers: { 'user-agent': 'vitest' } },
      envWithLines(),
    );

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
  });

  it('/crtm/stops/search rechaza query que normaliza a vacio', async () => {
    const res = await app.request(
      '/crtm/stops/search?name=%21%21%21',
      { headers: { 'user-agent': 'vitest' } },
      mockEnv(),
    );

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
  });

  it('/admin/refresh-cache con year=abc devuelve 400 (NaN inalcanzable antes)', async () => {
    const res = await app.request(
      '/admin/refresh-cache?year=abc',
      {
        method: 'POST',
        headers: { 'X-Admin-Secret': 'test-admin-secret' },
      },
      mockEnv(),
    );

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
  });
});

describe('GET /stops/nearby', () => {
  function envWithStopsAt(
    kvStops: Array<{ stopId: string; name: string; lat: number; lon: number; lines: string[] }>,
  ) {
    const kv = mockKV();
    const stops = kvStops.map((s) => ({
      stopId: s.stopId,
      name: s.name,
      coordinates: { latitude: s.lat, longitude: s.lon },
      lines: s.lines,
    }));
    kv.set(EMT_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(stops));
    return mockEnv(kv);
  }

  const sol = { lat: 40.4172, lon: -3.7038 };

  const madridStops = [
    { stopId: '1', name: 'Sol cercana', lat: 40.4173, lon: -3.7037, lines: ['1'] },
    { stopId: '2', name: 'Media distancia', lat: 40.42, lon: -3.706, lines: ['2'] },
    { stopId: '3', name: 'Lejos', lat: 40.45, lon: -3.75, lines: ['3'] },
  ];

  it('devuelve 400 si faltan lat o lon', async () => {
    const res1 = await app.request('/stops/nearby?lat=40.4', {}, envWithStopsAt(madridStops));
    const res2 = await app.request('/stops/nearby?lon=-3.7', {}, envWithStopsAt(madridStops));

    expect(res1.status).toBe(400);
    expect(res2.status).toBe(400);
  });

  it('devuelve 400 con lat/lon fuera de rango', async () => {
    const env = envWithStopsAt(madridStops);

    const resLat = await app.request('/stops/nearby?lat=95&lon=-3.7', {}, env);
    const resLon = await app.request('/stops/nearby?lat=40.4&lon=200', {}, env);

    expect(resLat.status).toBe(400);
    expect(resLon.status).toBe(400);
  });

  it('devuelve 400 con radius inválido (0, negativo, > 2000 o no numérico)', async () => {
    const env = envWithStopsAt(madridStops);

    for (const r of ['0', '-10', '2001', 'abc']) {
      const res = await app.request(`/stops/nearby?lat=40.4&lon=-3.7&radius=${r}`, {}, env);
      expect(res.status).toBe(400);
    }
  });

  it('ordena por distancia ascendente e incluye distanceM', async () => {
    const res = await app.request(
      `/stops/nearby?lat=${sol.lat}&lon=${sol.lon}&radius=2000`,
      {},
      envWithStopsAt(madridStops),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(2);
    expect(body.data.stops.map((s: { stopId: string }) => s.stopId)).toEqual(['1', '2']);
    expect(body.data.stops[0].distanceM).toBeLessThanOrEqual(body.data.stops[1].distanceM);
    expect(
      body.data.stops.every((s: { distanceM: number }) => typeof s.distanceM === 'number'),
    ).toBe(true);
  });

  it('respeta el radio de búsqueda', async () => {
    const res = await app.request(
      `/stops/nearby?lat=${sol.lat}&lon=${sol.lon}&radius=300`,
      {},
      envWithStopsAt(madridStops),
    );

    const body = await jsonBody(res);
    expect(body.data.count).toBe(1);
    expect(body.data.stops[0].stopId).toBe('1');
    expect(body.data.query.radius).toBe(300);
  });

  it('usa radius por defecto 300', async () => {
    const res = await app.request(
      `/stops/nearby?lat=${sol.lat}&lon=${sol.lon}`,
      {},
      envWithStopsAt(madridStops),
    );

    const body = await jsonBody(res);
    expect(body.data.query.radius).toBe(300);
    expect(body.data.count).toBe(1);
  });

  it('devuelve count 0 (success) si no hay paradas en el radio', async () => {
    const res = await app.request(
      `/stops/nearby?lat=40.4172&lon=-3.7038&radius=10`,
      {},
      envWithStopsAt([{ stopId: '9', name: 'Muy lejos', lat: 40.45, lon: -3.75, lines: ['1'] }]),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.count).toBe(0);
  });
});

describe('GET /lines', () => {
  it('devuelve todas las líneas del caché con Cache-Control cacheable', async () => {
    const res = await app.request('/lines', {}, envWithLines());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.count).toBe(2);
    expect(body.data.lines.map((l: { label: string }) => l.label)).toEqual(['1', '68']);
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=3600');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('devuelve 500 con formato unificado si la API EMT responde con error', async () => {
    const env = mockEnv();
    env.EMT_CACHE.put(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: '99', description: 'EMT down', data: [] }), {
          status: 200,
        }),
      ),
    );

    const res = await app.request('/lines', {}, env);

    expect(res.status).toBe(500);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
  });
});

describe('GET /lines/search y /lines/detail', () => {
  it('busca por label exacto', async () => {
    const res = await app.request('/lines/search?label=68', {}, envWithLines());

    const body = await jsonBody(res);
    expect(body.data.count).toBe(1);
    expect(body.data.lines[0].lineId).toBe('068');
  });

  it('busca por nombre normalizado', async () => {
    const res = await app.request('/lines/search?name=atocha', {}, envWithLines());

    const body = await jsonBody(res);
    expect(body.data.count).toBe(1);
    expect(body.data.lines[0].label).toBe('68');
  });

  it('devuelve 400 con formato de fecha inválido', async () => {
    const res = await app.request('/lines/detail/001?date=2026-08', {}, envWithLines());

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
    expect(body.message).toContain('YYYYMMDD');
  });

  it('devuelve 400 con lineId no numérico (incluye path traversal)', async () => {
    const res = await app.request('/lines/detail/..%2F..%2Fv1%2Fmobilitylabs', {}, envWithLines());

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.message).toBe('lineId debe ser numérico');
  });

  it('devuelve 400 con date fuera de la ventana permitida', async () => {
    const past = await app.request('/lines/detail/001?date=20200101', {}, envWithLines());
    const future = await app.request('/lines/detail/001?date=20991231', {}, envWithLines());

    expect(past.status).toBe(400);
    expect(future.status).toBe(400);
    const body = await jsonBody(future);
    expect(body.message).toContain('7 días');
  });

  it('devuelve 400 con lineId no numérico', async () => {
    const res = await app.request('/lines/timetable/abc', {}, envWithLines());

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.message).toBe('lineId debe ser numérico');
  });

  it('GET /timetable devuelve del KV sin llamar a fetch', async () => {
    const env = envWithLines();
    const cached = {
      lineId: '001',
      schedules: {
        laboral: [
          {
            StartTime: '07:00',
            StopTime: '23:00',
            MinimunFrequency: '6',
            MaximumFrequency: '12',
            FrequencyText: '6-12 min',
          },
        ],
      },
    };
    env.EMT_CACHE.put(`${EMT_CONFIG.CACHE_KEYS.LINE_TIMETABLE}001`, JSON.stringify(cached));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request('/lines/timetable/001', {}, env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.lineId).toBe('001');
    expect(body.data.dayTypes).toEqual(['laboral']);
    expect(body.data.schedules.laboral[0].StartTime).toBe('07:00');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /timetable hace fetch y cachea si no hay caché', async () => {
    const env = envWithLines();
    env.EMT_CACHE.put(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
    );
    const today = formatDateYYYYMMDD(new Date());
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const body = url.endsWith(`/lines/001/info/${today}/`)
        ? lineDetailResponse('001', '1')
        : null;
      return Promise.resolve(
        new Response(JSON.stringify(body ?? { code: '99', description: 'unexpected', data: [] }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request('/lines/timetable/001', {}, env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.dayTypes).toEqual(['laboral', 'sabado', 'festivo']);
    expect(body.data.schedules.laboral).toHaveLength(2);
    const cached = await env.EMT_CACHE.get(`${EMT_CONFIG.CACHE_KEYS.LINE_TIMETABLE}001`);
    expect(cached).toBeTruthy();
  });

  it('GET /timetable devuelve 500 si la API EMT responde con error', async () => {
    const env = envWithLines();
    env.EMT_CACHE.put(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: '99', description: 'EMT down', data: [] }), {
          status: 200,
        }),
      ),
    );

    const res = await app.request('/lines/timetable/001', {}, env);

    expect(res.status).toBe(500);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
  });

  it('GET /route devuelve 400 con label inválido', async () => {
    const res = await app.request('/lines/route/1%2F2', {}, envWithLines());

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.message).toContain('label');
  });

  it('GET /route devuelve la geometría cacheada sin llamar a fetch', async () => {
    const env = envWithLines();
    const emtResp = lineRouteResponse('1', '001').data;
    const cached = {
      label: '1',
      lineId: '001',
      nameA: emtResp.nameSectionA,
      nameB: emtResp.nameSectionB,
      itinerary: emtResp.itinerary,
      stops: emtResp.stops,
    };
    env.EMT_CACHE.put(`${EMT_CONFIG.CACHE_KEYS.LINE_ROUTE}1`, JSON.stringify(cached));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request('/lines/route/1', {}, env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.label).toBe('1');
    expect(body.data.itinerary.toA.type).toBe('FeatureCollection');
    expect(body.data.stops.toA.features[0].properties.stopName).toBe('Prosperidad');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /route hace fetch, cachea y mapea nameSectionA/B', async () => {
    const env = envWithLines();
    env.EMT_CACHE.put(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
    );
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const body = url.endsWith('/lines/27/route/') ? lineRouteResponse('27', '027') : null;
      return Promise.resolve(
        new Response(JSON.stringify(body ?? { code: '99', description: 'unexpected', data: [] }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request('/lines/route/27', {}, env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.label).toBe('27');
    expect(body.data.nameA).toBe('PROSPERIDAD');
    expect(body.data.nameB).toBe('PLAZA DE CRISTO REY');
    expect(await env.EMT_CACHE.get(`${EMT_CONFIG.CACHE_KEYS.LINE_ROUTE}27`)).toBeTruthy();
  });

  it('GET /route devuelve 404 si la EMT devuelve data vacía', async () => {
    const env = envWithLines();
    env.EMT_CACHE.put(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify(lineRouteEmptyResponse()), { status: 200 })),
        ),
    );

    const res = await app.request('/lines/route/999', {}, env);

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.message).toContain('No existe ruta');
  });
});

describe('GET /lines/incidents/:label', () => {
  function envWithIncidents() {
    const env = envWithLines();
    env.EMT_CACHE.put(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
    );
    return env;
  }

  it('devuelve 400 con label inválido', async () => {
    const res = await app.request('/lines/incidents/5%20x', {}, envWithLines());

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.message).toContain('label');
  });

  it('hace fetch del feed all, filtra por label y cachea con TTL corto', async () => {
    const env = envWithIncidents();
    const { response } = incidentsResponse();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const body = url.endsWith('/lines/incidents/all/') ? response : null;
      return Promise.resolve(
        new Response(JSON.stringify(body ?? { code: '99', description: 'unexpected', data: [] }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request('/lines/incidents/5', {}, env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.label).toBe('5');
    expect(body.data.count).toBe(2);
    expect(body.data.incidents.map((i: { id: string }) => i.id)).toEqual([
      'active-5',
      'upcoming-5-150',
    ]);
    expect(body.data.lastBuildDate).toBe('Mon, 17 Aug 2026 10:53:13 GMT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await env.EMT_CACHE.get(EMT_CONFIG.CACHE_KEYS.INCIDENTS_ALL)).toBeTruthy();
  });

  it('devuelve del KV en la segunda llamada (un solo fetch para dos labels)', async () => {
    const env = envWithIncidents();
    const { response } = incidentsResponse();
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(response), { status: 200 })),
      );
    vi.stubGlobal('fetch', fetchMock);

    await app.request('/lines/incidents/5', {}, env);
    const res = await app.request('/lines/incidents/150', {}, env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.incidents.map((i: { id: string }) => i.id)).toEqual(['upcoming-5-150']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('all devuelve todas las vigentes y label sin incidencias devuelve count 0', async () => {
    const env = envWithIncidents();
    const { response } = incidentsResponse();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify(response), { status: 200 })),
        ),
    );

    const resAll = await app.request('/lines/incidents/all', {}, env);
    const bodyAll = await jsonBody(resAll);
    expect(bodyAll.data.label).toBe('all');
    expect(bodyAll.data.incidents.map((i: { id: string }) => i.id)).toEqual([
      'active-5',
      'upcoming-5-150',
      'no-dates-N13',
    ]);

    const resNone = await app.request('/lines/incidents/999', {}, env);
    const bodyNone = await jsonBody(resNone);
    expect(resNone.status).toBe(200);
    expect(bodyNone.status).toBe('success');
    expect(bodyNone.data.count).toBe(0);
  });

  it('devuelve 200 con count 0 si el feed viene vacío (la EMT no distingue línea inexistente)', async () => {
    const env = envWithIncidents();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(incidentsEmptyResponse()), { status: 200 })),
    );

    const res = await app.request('/lines/incidents/5', {}, env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.count).toBe(0);
  });

  it('devuelve 500 si la API EMT responde con error', async () => {
    const env = envWithIncidents();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: '99', description: 'EMT down', data: [] }), {
          status: 200,
        }),
      ),
    );

    const res = await app.request('/lines/incidents/5', {}, env);

    expect(res.status).toBe(500);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
  });
});

describe('POST /admin/refresh-cache', () => {
  function envWithToken() {
    const env = mockEnv();
    env.EMT_CACHE.put(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
    );
    return env;
  }

  function stubEMTAll() {
    const today = formatDateYYYYMMDD(new Date());
    const year = new Date().getFullYear();
    return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body =
        method === 'POST' && url.endsWith(EMT_CONFIG.ENDPOINTS.STOPS_LIST)
          ? stopsResponse()
          : url.endsWith(`${EMT_CONFIG.ENDPOINTS.LINES_INFO}${today}/`)
            ? linesResponse()
            : url.endsWith(`/calendar/${year}0101/${year}1231/`)
              ? calendarResponse()
              : null;
      return Promise.resolve(
        new Response(JSON.stringify(body ?? { code: '99', description: 'unexpected', data: [] }), {
          status: 200,
        }),
      );
    });
  }

  it('devuelve 401 sin cabecera X-Admin-Secret', async () => {
    const res = await app.request('/admin/refresh-cache', { method: 'POST' }, envWithToken());

    expect(res.status).toBe(401);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
  });

  it('devuelve 401 con secret incorrecto', async () => {
    const res = await app.request(
      '/admin/refresh-cache',
      {
        method: 'POST',
        headers: { 'X-Admin-Secret': 'wrong' },
      },
      envWithToken(),
    );

    expect(res.status).toBe(401);
  });

  it('devuelve 503 si ADMIN_SECRET no está configurado', async () => {
    const env = envWithToken();
    env.ADMIN_SECRET = '';
    const res = await app.request('/admin/refresh-cache', { method: 'POST' }, env);

    expect(res.status).toBe(503);
  });

  it('refresca la caché con el secret correcto', async () => {
    const fetchMock = stubEMTAll();
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request(
      '/admin/refresh-cache',
      {
        method: 'POST',
        headers: { 'X-Admin-Secret': 'test-admin-secret' },
      },
      envWithToken(),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.stops).toBe(2);
    expect(body.data.lines).toBe(2);
    expect(body.data.calendar).toBe(4);
  });

  it('devuelve 400 con year inválido', async () => {
    const res = await app.request(
      '/admin/refresh-cache?year=1999',
      {
        method: 'POST',
        headers: { 'X-Admin-Secret': 'test-admin-secret' },
      },
      envWithToken(),
    );

    expect(res.status).toBe(400);
  });
});

describe('GET /stops/arrivals/:stopId', () => {
  function envWithTokenAndFetchMock(stopId: string, line?: string) {
    const env = mockEnv();
    env.EMT_CACHE.put(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
    );
    const suffix = line ? `${stopId}/arrives/${line}/` : `${stopId}/arrives/`;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = method === 'POST' && url.endsWith(suffix) ? arrivesResponse() : null;
      return Promise.resolve(
        new Response(JSON.stringify(body ?? { code: '99', description: 'unexpected', data: [] }), {
          status: 200,
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    return { env, fetchMock };
  }

  it('devuelve 400 con stopId no numérico', async () => {
    const res = await app.request('/stops/arrivals/abc', {}, mockEnv());

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.message).toBe('stopId debe ser numérico');
  });

  it('devuelve 400 con line inválida', async () => {
    const res = await app.request('/stops/arrivals/62?line=4/5', {}, mockEnv());

    expect(res.status).toBe(400);
    const body = await jsonBody(res);
    expect(body.message).toContain('line');
  });

  it('devuelve las llegadas ordenadas para la parada', async () => {
    const { env } = envWithTokenAndFetchMock('211');

    const res = await app.request('/stops/arrivals/211', {}, env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.stopId).toBe('211');
    expect(body.data.line).toBeNull();
    expect(body.data.count).toBe(5);
    expect(body.data.arrivals[0].line).toBe('45');
    expect(body.data.arrivals[0].busPosition).toEqual({ latitude: 40.4131, longitude: -3.6928 });
    expect(
      body.data.arrivals.map((a: { estimateArriveSec: number }) => a.estimateArriveSec),
    ).toEqual([71, 74, 620, 950, 999999]);
  });

  it('propaga la línea al endpoint EMT', async () => {
    const { env, fetchMock } = envWithTokenAndFetchMock('212', '45');

    const res = await app.request('/stops/arrivals/212?line=45', {}, env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.line).toBe('45');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/stops/212/arrives/45/'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('devuelve 404 si la parada no existe (EMT code 80)', async () => {
    const env = mockEnv();
    env.EMT_CACHE.put(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: '80',
            description: [{ ES: 'Parada no disponible actualmente o inexistente' }],
            data: [],
          }),
          { status: 200 },
        ),
      ),
    );

    const res = await app.request('/stops/arrivals/9999', {}, env);

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
    expect(body.message).toContain('no disponible actualmente o inexistente');
  });

  it('devuelve 500 si la API EMT responde con error', async () => {
    const env = mockEnv();
    env.EMT_CACHE.put(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: '99', description: 'EMT down', data: [] }), {
          status: 200,
        }),
      ),
    );

    const res = await app.request('/stops/arrivals/213', {}, env);

    expect(res.status).toBe(500);
    const body = await jsonBody(res);
    expect(body.status).toBe('error');
  });
});

describe('rate limiting', () => {
  function envWithLimiter(limit: number) {
    const kv = mockKV();
    const stops = [
      {
        stopId: '123',
        name: 'Plaza de España',
        coordinates: { latitude: 1, longitude: 2 },
        lines: ['1'],
      },
    ];
    kv.set(EMT_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(stops));
    kv.set(
      EMT_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify([{ lineId: '001', label: '1', nameA: 'A', nameB: 'B' }]),
    );
    const limiter = mockRateLimiter(limit);
    return { env: mockEnv(kv, limiter), limiter };
  }

  it('devuelve 429 con formato unificado y Retry-After al superar el límite', async () => {
    const { env } = envWithLimiter(1);

    const first = await app.request('/stops/search?stopId=123', {}, env);
    const second = await app.request('/stops/search?stopId=123', {}, env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    const body = await jsonBody(second);
    expect(body.status).toBe('error');
    expect(body.message).toContain('peticiones');
    expect(second.headers.get('Retry-After')).toBe('60');
  });

  it('construye la clave como grupo:ip con cf-connecting-ip', async () => {
    const { env, limiter } = envWithLimiter(Infinity);

    await app.request(
      '/stops/search?stopId=123',
      { headers: { 'cf-connecting-ip': '1.2.3.4' } },
      env,
    );
    await app.request('/stops/search?stopId=123', {}, env);

    expect(limiter.calls).toEqual(['stops:1.2.3.4', 'stops:unknown']);
  });

  it('contadores independientes por grupo de rutas', async () => {
    const { env } = envWithLimiter(1);

    const stopsFirst = await app.request('/stops/search?stopId=123', {}, env);
    const stopsSecond = await app.request('/stops/search?stopId=123', {}, env);
    const linesFirst = await app.request('/lines/search?label=1', {}, env);

    expect(stopsFirst.status).toBe(200);
    expect(stopsSecond.status).toBe(429);
    expect(linesFirst.status).toBe(200);
  });

  it('aplica rate limit también a /lines sin subruta', async () => {
    const { env } = envWithLimiter(1);

    const first = await app.request('/lines', {}, env);
    const second = await app.request('/lines', {}, env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it('fail-open si el binding RATE_LIMITER no está configurado', async () => {
    const kv = mockKV();
    const stops = [
      {
        stopId: '123',
        name: 'Plaza de España',
        coordinates: { latitude: 1, longitude: 2 },
        lines: ['1'],
      },
    ];
    kv.set(EMT_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(stops));
    const env = mockEnv(kv);
    Reflect.deleteProperty(env, 'RATE_LIMITER');

    const res = await app.request('/stops/search?stopId=123', {}, env);

    expect(res.status).toBe(200);
  });

  it('no aplica a /health', async () => {
    const { env } = envWithLimiter(1);

    await app.request('/health', {}, env);
    const res = await app.request('/health', {}, env);

    expect(res.status).toBe(200);
  });
});

describe('rate limiting: bypass X-SSR-Key para el SSR propio (W1)', () => {
  const SSR_KEY = 'test-ssr-key-0123456789abcdef0123456789abcdef';

  function envWithSsrKey(limit: number, withSecret = true) {
    const kv = mockKV();
    const stops = [
      {
        stopId: '123',
        name: 'Plaza de España',
        coordinates: { latitude: 1, longitude: 2 },
        lines: ['1'],
      },
    ];
    kv.set(EMT_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(stops));
    kv.set(
      EMT_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify([{ lineId: '001', label: '1', nameA: 'A', nameB: 'B' }]),
    );
    kv.set(CRTM_CONFIG.CACHE_KEYS.META, JSON.stringify(crtmMetaFixture()));
    const limiter = mockRateLimiter(limit);
    const env = mockEnv(kv, limiter);
    if (withSecret) {
      env.SSR_INTERNAL_KEY = SSR_KEY;
    }
    return { env, limiter };
  }

  it('ráfaga de 70 con key correcta → 70×200 y cero llamadas al binding (unidad no consumida)', async () => {
    const { env, limiter } = envWithSsrKey(60);

    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) {
      const res = await app.request(
        '/stops/search?stopId=123',
        { headers: { 'X-SSR-Key': SSR_KEY } },
        env,
      );
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 200)).toHaveLength(70);
    expect(limiter.calls).toHaveLength(0);
  });

  it('sin key → 429 desde la 61', async () => {
    const { env } = envWithSsrKey(60);

    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      const res = await app.request('/stops/search?stopId=123', {}, env);
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it('key malformada → limita igual que sin key', async () => {
    const { env, limiter } = envWithSsrKey(60);

    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      const res = await app.request(
        '/stops/search?stopId=123',
        { headers: { 'X-SSR-Key': 'otra-key-completamente-distinta' } },
        env,
      );
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    expect(limiter.calls).toHaveLength(61);
  });

  it('sin SSR_INTERNAL_KEY en env → bypass inactivo (fail-closed)', async () => {
    const { env, limiter } = envWithSsrKey(2, false);

    const first = await app.request(
      '/stops/search?stopId=123',
      { headers: { 'X-SSR-Key': SSR_KEY } },
      env,
    );
    const second = await app.request(
      '/stops/search?stopId=123',
      { headers: { 'X-SSR-Key': SSR_KEY } },
      env,
    );
    const third = await app.request(
      '/stops/search?stopId=123',
      { headers: { 'X-SSR-Key': SSR_KEY } },
      env,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(limiter.calls).toHaveLength(3);
  });

  it('con key correcta el bypass cubre las familias stops|lines|crtm|search', async () => {
    const { env, limiter } = envWithSsrKey(1);

    const families = ['/stops/search?stopId=123', '/lines', '/crtm/status', '/search?q=1'];

    for (const path of families) {
      const res = await app.request(path, { headers: { 'X-SSR-Key': SSR_KEY } }, env);
      expect(res.status).toBe(200);
    }

    expect(limiter.calls).toHaveLength(0);
  });

  it('/admin/* NO se salta el rate limit aunque la key sea correcta', async () => {
    const { env, limiter } = envWithSsrKey(1);

    await app.request(
      '/admin/refresh-cache',
      { method: 'POST', headers: { 'X-SSR-Key': SSR_KEY } },
      env,
    );

    expect(limiter.calls).toEqual(['admin:unknown']);
  });
});

describe('GET /stops/detail/:stopId', () => {
  it('devuelve 400 con stopId no numérico', async () => {
    const res = await app.request('/stops/detail/abc', {}, mockEnv());

    expect(res.status).toBe(400);
  });

  it('devuelve el detalle con Cache-Control cacheable', async () => {
    const env = envWithStops();
    env.EMT_CACHE.put(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const body = url.endsWith('/stops/123/detail/') ? stopDetailResponse('123') : null;
        return Promise.resolve(
          new Response(
            JSON.stringify(body ?? { code: '99', description: 'unexpected', data: [] }),
            { status: 200 },
          ),
        );
      }),
    );

    const res = await app.request('/stops/detail/123', {}, env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.stopId).toBe('123');
    expect(body.data.postalAddress).toBe('Calle Mayor 1');
    expect(body.data.lines[0].label).toBe('1');
    expect(res.headers.get('Cache-Control')).toContain('max-age=300');
  });

  it('devuelve 404 si la EMT responde code 90 (parada inexistente)', async () => {
    const env = mockEnv();
    env.EMT_CACHE.put(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
    );
    // Response fresco por llamada: el pre-check del listado y el fetch del detalle consumen bodies distintos (como un fetch real)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              code: '90',
              description: 'Error managing internal services',
              data: [],
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    const res = await app.request('/stops/detail/9999', {}, env);

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.message).toContain('no disponible actualmente o inexistente');
  });

  it('devuelve 503 si la EMT da code 90 pero la parada existe en el listado (microcaída EMT)', async () => {
    const env = mockEnv();
    env.EMT_CACHE.put(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
    );
    env.EMT_CACHE.put(
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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: '90',
            description: 'Error managing internal services',
            data: [],
          }),
          { status: 200 },
        ),
      ),
    );

    const res = await app.request('/stops/detail/5907', {}, env);

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    const body = await jsonBody(res);
    expect(body.message).toContain('no ha podido servir el detalle');
  });

  it('devuelve 404 sin llamar a EMT si la parada no está en el listado oficial', async () => {
    const env = envWithStops();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request('/stops/detail/9999', {}, env);

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.message).toContain('no disponible actualmente o inexistente');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Cache-Control', () => {
  it('/stops/search cacheable con Vary: Origin', async () => {
    const res = await app.request('/stops/search?stopId=123', {}, envWithStops());

    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=3600');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('/stops/nearby cacheable', async () => {
    const kv = mockKV();
    kv.set(EMT_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify([]));
    const res = await app.request('/stops/nearby?lat=40.4&lon=-3.7', {}, mockEnv(kv));

    expect(res.headers.get('Cache-Control')).toContain('max-age=300');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('/lines/search cacheable', async () => {
    const res = await app.request('/lines/search?label=1', {}, envWithLines());

    expect(res.headers.get('Cache-Control')).toContain('s-maxage=3600');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('/lines/incidents cacheable con s-maxage alineado al TTL del feed (1800)', async () => {
    const env = mockEnv();
    env.EMT_CACHE.put(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(incidentsResponse().response), { status: 200 }),
        ),
    );

    const res = await app.request('/lines/incidents/5', {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=1800');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('/stops/arrivals no-store', async () => {
    const env = mockEnv();
    env.EMT_CACHE.put(
      EMT_CONFIG.CACHE_KEYS.ACCESS_TOKEN,
      JSON.stringify({ accessToken: 'valid-token', expiresAt: Date.now() + 3600_000 }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(arrivesResponse()), { status: 200 })),
    );

    const res = await app.request('/stops/arrivals/300', {}, env);

    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('errores 4xx no llevan Cache-Control cacheable', async () => {
    const res = await app.request('/stops/search', {}, envWithStops());

    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBeNull();
    expect(res.headers.get('Vary')).toBe('Origin');
  });
});
