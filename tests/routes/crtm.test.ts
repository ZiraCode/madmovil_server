import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonBody } from '../helpers/json';
import app from '../../src/index';
import { CRTM_CONFIG, EMT_CONFIG } from '../../src/lib/config';
import { mockEnv, mockKV, mockR2, mockRateLimiter } from '../helpers/mock-kv';
import { patchAppRequestWithUA } from '../helpers/ua';
import {
  CRTM_TEST_NOW,
  crtmStopsFixture,
  crtmLinesAllFixture,
  crtmScheduleDocsFixture,
  crtmTimetableDocFixture,
  crtmMetaFixture,
  crtmRouteDocFixture,
  crtmCercaniasStopsFixture,
  crtmCercaniasLinesAllFixture,
  crtmCercaniasDocsFixture,
  crtmCercaniasIncidentsFixture,
  crtmRenfeRealtimeFixture,
  crtmWidgetStopTimesFixture,
  crtmWidgetGetStopsFixture,
} from '../fixtures/crtm';
import { __resetRealtimeCache } from '../../src/lib/crtm-rt';
import { __resetWidgetCache } from '../../src/lib/crtm-widget';
import { __resetIncidentsInflight } from '../../src/lib/crtm-incidents';
import { madridWallClock } from '../../src/lib/date-utils';
import type { CRTMLineDoc, CRTMService } from '../../src/types/crtm-data';

const rawRequest = patchAppRequestWithUA(app);

afterEach(() => {
  vi.useRealTimers();
});

function seedCRTM(kv = mockKV(), lineDocs: CRTMLineDoc[], withMeta = true) {
  kv.set(CRTM_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(crtmStopsFixture()));
  kv.set(CRTM_CONFIG.CACHE_KEYS.LINES_ALL, JSON.stringify(crtmLinesAllFixture()));
  for (const doc of lineDocs) {
    kv.set(`${CRTM_CONFIG.CACHE_KEYS.LINE_PREFIX}${doc.routeId}`, JSON.stringify(doc));
  }
  if (withMeta) {
    kv.set(CRTM_CONFIG.CACHE_KEYS.META, JSON.stringify(crtmMetaFixture()));
  }
  return mockEnv(kv);
}

function envSchedule(withMeta = true) {
  return seedCRTM(mockKV(), crtmScheduleDocsFixture(), withMeta);
}

function envTimetable() {
  return seedCRTM(mockKV(), [crtmTimetableDocFixture()]);
}

describe('bot-filter en /crtm/*', () => {
  it('rechaza sin User-Agent', async () => {
    const res = await rawRequest('/crtm/stops/search?stopId=09568', {}, envSchedule());

    expect(res.status).toBe(403);
  });
});

describe('GET /crtm/stops/search', () => {
  it('busca por stopCode exacto', async () => {
    const res = await app.request('/crtm/stops/search?stopId=09568', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.count).toBe(1);
    expect(body.data.stops[0].name).toBe('Pº Extremadura - Av. Portugal');
    expect(body.data.stops[0].municipality).toBe('Madrid');
  });

  it('busca por stopCode namespacelado de ml (10_5)', async () => {
    const res = await app.request('/crtm/stops/search?stopId=10_5', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(1);
    expect(body.data.stops[0].code).toBe('10_5');
    expect(body.data.stops[0].lines).toEqual(['ML2']);
    expect(body.data.stops[0].municipality).toBe('Pozuelo de Alarcón');
  });

  it('busca por nombre normalizado sin acentos', async () => {
    const res = await app.request('/crtm/stops/search?name=extremadura', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(1);
    expect(body.data.stops[0].code).toBe('09568');
  });

  it('busca también por dirección y por municipio', async () => {
    const env = envSchedule();

    const byAddress = await jsonBody(
      await app.request('/crtm/stops/search?name=portugal', {}, env),
    );
    const byMunicipality = await jsonBody(
      await app.request('/crtm/stops/search?name=alcorcon', {}, env),
    );

    expect(byAddress.data.count).toBe(1);
    expect(byAddress.data.stops[0].code).toBe('09568');
    expect(byMunicipality.data.count).toBe(1);
    expect(byMunicipality.data.stops[0].code).toBe('08712');
  });

  it('query numérica: número de vía exacto sí, dígitos dentro de números largos no', async () => {
    const kv = mockKV();
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([
        ...crtmStopsFixture(),
        {
          code: '1927',
          name: 'Pº STA.Mª CABEZA-EMBAJADORES',
          address: 'Paseo de Santa María de la Cabeza 62',
          lat: 40.40144,
          lon: -3.698855,
          zone: 'A',
          municipality: 'Madrid',
          lines: ['463'],
        },
        {
          code: '06159',
          name: 'CTRA.M505-URB.LOS GAMOS',
          address: 'Ctra del Escorial 16200',
          lat: 40.570183,
          lon: -3.988787,
          zone: 'B3',
          municipality: 'Galapagar',
          lines: ['661'],
        },
      ]),
    );
    const env = mockEnv(kv);

    const res = await app.request('/crtm/stops/search?name=62', {}, env);
    const body = await jsonBody(res);

    expect(body.data.count).toBe(1);
    expect(body.data.stops[0].code).toBe('1927');
  });

  it('query numérica con frontera al final de la dirección ("Av. de Portugal 12" con name=12)', async () => {
    const res = await app.request('/crtm/stops/search?name=12', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(1);
    expect(body.data.stops[0].code).toBe('09568');
  });

  it('limit recorta el listado sin perder el total (count vs returned)', async () => {
    const res = await app.request('/crtm/stops/search?name=madrid&limit=1', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(2);
    expect(body.data.returned).toBe(1);
    expect(body.data.stops).toHaveLength(1);
  });

  it('devuelve 400 sin parámetros y con limit inválido', async () => {
    const env = envSchedule();

    const noParams = await app.request('/crtm/stops/search', {}, env);
    const limit0 = await app.request('/crtm/stops/search?name=x&limit=0', {}, env);
    const limitBig = await app.request('/crtm/stops/search?name=x&limit=101', {}, env);
    const limitNaN = await app.request('/crtm/stops/search?name=x&limit=abc', {}, env);

    expect(noParams.status).toBe(400);
    expect(limit0.status).toBe(400);
    expect(limitBig.status).toBe(400);
    expect(limitNaN.status).toBe(400);
  });

  it('devuelve 503 si el artefacto crtm:stops:all no está cargado', async () => {
    const res = await app.request('/crtm/stops/search?stopId=09568', {}, mockEnv());

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('300');
    const body = await jsonBody(res);
    expect(body.message).toContain('CRTM');
  });

  it('cacheable con Vary: Origin', async () => {
    const res = await app.request('/crtm/stops/search?stopId=09568', {}, envSchedule());

    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=3600');
    expect(res.headers.get('Vary')).toBe('Origin');
  });
});

describe('GET /crtm/stops/nearby', () => {
  const moncloa = { lat: 40.4295, lon: -3.7418 };

  it('devuelve 400 si faltan lat/lon o son inválidos', async () => {
    const env = envSchedule();

    const missing = await app.request('/crtm/stops/nearby?lat=40.4', {}, env);
    const badLat = await app.request('/crtm/stops/nearby?lat=95&lon=-3.7', {}, env);
    const badRadius = await app.request('/crtm/stops/nearby?lat=40.4&lon=-3.7&radius=0', {}, env);

    expect(missing.status).toBe(400);
    expect(badLat.status).toBe(400);
    expect(badRadius.status).toBe(400);
  });

  it('ordena por distancia e incluye distanceM y datos CRTM (municipality/zone)', async () => {
    const res = await app.request(
      `/crtm/stops/nearby?lat=${moncloa.lat}&lon=${moncloa.lon}`,
      {},
      envSchedule(),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(2);
    expect(body.data.stops.map((s: { code: string }) => s.code)).toEqual(['09999', '09568']);
    expect(body.data.stops[0].distanceM).toBe(0);
    expect(body.data.stops[1].municipality).toBe('Madrid');
    expect(body.data.stops[1].zone).toBe('A');
  });

  it('respeta el radio', async () => {
    const res = await app.request(
      `/crtm/stops/nearby?lat=${moncloa.lat}&lon=${moncloa.lon}&radius=100`,
      {},
      envSchedule(),
    );

    const body = await jsonBody(res);
    expect(body.data.count).toBe(1);
    expect(body.data.stops[0].code).toBe('09999');
    expect(body.data.query.radius).toBe(100);
  });
});

describe('GET /crtm/lines', () => {
  it('devuelve el listado completo con network para los chips (incluye ml con color)', async () => {
    const res = await app.request('/crtm/lines', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.count).toBe(5);
    expect(body.data.lines.map((l: { network: string }) => l.network)).toEqual([
      'interurban',
      'urban',
      'urban',
      'urban',
      'ml',
    ]);
    const ml = body.data.lines.find((l: { label: string }) => l.label === 'ML2');
    expect(ml).toMatchObject({
      routeId: '10__ML2___',
      network: 'ml',
      color: '00A0E9',
      textColor: 'FFFFFF',
    });
    expect(body.data.lines[0].url).toBe('https://www.crtm.es/8__421___');
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=3600');
  });

  it('devuelve 503 si crtm:lines:all no está cargado', async () => {
    const res = await app.request('/crtm/lines', {}, mockEnv());

    expect(res.status).toBe(503);
  });
});

describe('GET /crtm/lines/detail/:id', () => {
  it('por label devuelve todas las redes con ese label (colisión interurbano/urbano)', async () => {
    const res = await app.request('/crtm/lines/detail/421', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(3);
    expect(body.data.lines.map((l: { routeId: string }) => l.routeId)).toEqual([
      '8__421___',
      '9__421___',
      '9__999___',
    ]);

    const first = body.data.lines[0];
    expect(first.tripCount).toBe(7);
    expect(first.directions).toHaveLength(2);
    // destino canónico: el nombre "Moncloa - Boadilla del Monte" gana al headsign de calle "Madrid (Moncloa)"
    expect(first.directions[0].headsign).toBe('Moncloa');
    expect(first.directions[1].headsign).toBe('Boadilla del Monte');
    expect(first.directions[0].stops[0]).toEqual({
      code: '09568',
      name: 'Pº Extremadura - Av. Portugal',
      lat: 40.4281,
      lon: -3.7405,
    });
  });

  it('por routeId exacto devuelve un único doc', async () => {
    const res = await app.request('/crtm/lines/detail/8__421___', {}, envSchedule());

    const body = await jsonBody(res);
    expect(body.data.count).toBe(1);
    expect(body.data.lines[0].network).toBe('interurban');
    expect(body.data.lines[0].url).toBe('https://www.crtm.es/8__421___');
  });

  it('detail de línea ml con color/textColor y paradas namespaceladas', async () => {
    const res = await app.request('/crtm/lines/detail/ML2', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(1);
    const line = body.data.lines[0];
    expect(line).toMatchObject({
      routeId: '10__ML2___',
      network: 'ml',
      color: '00A0E9',
      textColor: 'FFFFFF',
    });
    expect(line.directions[0].stops[0]).toMatchObject({
      code: '10_5',
      name: 'Somosaguas Sur - ML2',
    });
  });

  it('devuelve 404 para una línea inexistente y 400 para ids inválidos', async () => {
    const env = envSchedule();

    const notFound = await app.request('/crtm/lines/detail/999', {}, env);
    const invalid = await app.request('/crtm/lines/detail/4%21x', {}, env);

    expect(notFound.status).toBe(404);
    expect((await jsonBody(notFound)).message).toContain('No existe la línea CRTM 999');
    expect(invalid.status).toBe(400);
  });

  it('devuelve 503 si el label existe en lines:all pero su doc de KV falta', async () => {
    const res = await app.request('/crtm/lines/detail/1', {}, envSchedule());

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('300');
  });
});

describe('GET /crtm/lines/timetable/:id', () => {
  it('primer/último servicio y expediciones por dirección y patrón de servicio', async () => {
    const res = await app.request('/crtm/lines/timetable/8__421___', {}, envTimetable());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(1);

    const line = body.data.lines[0];
    expect(line.directions).toHaveLength(2);

    const dir0 = line.directions[0];
    expect(dir0).toMatchObject({ first: '06:00', last: '22:00', trips: 5 });
    expect(dir0.services.map((s: { id: string }) => s.id)).toEqual(['LAB', 'FIN']);
    expect(dir0.services[1]).toMatchObject({ first: '08:00', last: '09:30', trips: 2 });

    const dir1 = line.directions[1];
    expect(dir1).toMatchObject({ first: '07:00', last: '24:15', trips: 3 });
  });

  it('devuelve 404 para una línea inexistente', async () => {
    const res = await app.request('/crtm/lines/timetable/999', {}, envTimetable());

    expect(res.status).toBe(404);
  });
});

// Red en modo catálogo (feed stale, p. ej. Metro M4): líneas/estaciones/geometría visibles
// pero sin horarios oficiales — schedule/timetable responden 200 con flag explícito
describe('modo catálogo: red sin horarios (feed stale)', () => {
  function envCatalog() {
    const kv = mockKV();
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([
        {
          code: '4_250',
          name: 'Iglesia',
          address: 'Calle de la Iglesia 3',
          lat: 40.4189,
          lon: -3.7048,
          zone: 'A',
          municipality: 'Madrid',
          lines: ['1'],
        },
      ]),
    );
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify({
        count: 1,
        lines: [
          {
            label: '1',
            routeId: '4__1_____',
            name: 'Pinar de Chamartín - Valdecarros',
            network: 'metro',
            municipality: 'Madrid',
            url: null,
            color: '58ABE8',
            textColor: 'FFFFFF',
            noSchedule: true,
          },
        ],
      }),
    );
    kv.set(
      `${CRTM_CONFIG.CACHE_KEYS.LINE_PREFIX}4__1_____`,
      JSON.stringify({
        routeId: '4__1_____',
        label: '1',
        name: 'Pinar de Chamartín - Valdecarros',
        network: 'metro',
        municipality: 'Madrid',
        url: null,
        color: '58ABE8',
        textColor: 'FFFFFF',
        noSchedule: { calendarEnd: '20260527', feedVersions: ['20250527'] },
        directions: [
          { id: 0, headsign: 'Valdecarros', stops: ['4_263', '4_250', '4_261'] },
          { id: 1, headsign: 'Pinar de Chamartín', stops: ['4_261', '4_250', '4_263'] },
        ],
      }),
    );
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.META,
      JSON.stringify({
        ...crtmMetaFixture(),
        versions: {
          ...crtmMetaFixture().versions,
          metro: {
            itemModified: 1748601600000,
            zipBytes: 1500000,
            feedVersions: ['20250527'],
            catalogOnly: 'calendario caducado (20260527)',
          },
        },
      }),
    );
    return mockEnv(kv);
  }

  it('search encuentra la estación de metro por stopId namespacelado (4_250)', async () => {
    const res = await app.request('/crtm/stops/search?stopId=4_250', {}, envCatalog());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(1);
    expect(body.data.stops[0]).toMatchObject({ code: '4_250', name: 'Iglesia', lines: ['1'] });
  });

  it('chips de la red de catálogo con noSchedule y color', async () => {
    const res = await app.request('/crtm/lines', {}, envCatalog());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.lines[0]).toMatchObject({
      routeId: '4__1_____',
      network: 'metro',
      color: '58ABE8',
      noSchedule: true,
    });
  });

  it('schedule de estación de catálogo: 200 con noScheduleData (calendarEnd/feedVersions) y sin salidas', async () => {
    vi.setSystemTime(new Date(CRTM_TEST_NOW));
    const res = await app.request('/crtm/stops/schedule/4_250', {}, envCatalog());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.count).toBe(0);
    expect(body.data.departures).toEqual([]);
    expect(body.data.noScheduleData).toEqual({
      networks: ['metro'],
      calendarEnd: '20260527',
      feedVersions: ['20250527'],
    });
    expect(body.message).toContain('27/05/2026');
    vi.useRealTimers();
  });

  it('detail de línea de catálogo: tripCount 0, services vacíos, noSchedule y headsigns de cabecera', async () => {
    const res = await app.request('/crtm/lines/detail/4__1_____', {}, envCatalog());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    const line = body.data.lines[0];
    expect(line.noSchedule).toEqual({ calendarEnd: '20260527', feedVersions: ['20250527'] });
    expect(line.tripCount).toBe(0);
    expect(line.services).toEqual([]);
    expect(line.directions.map((d: { headsign: string }) => d.headsign)).toEqual([
      'Valdecarros',
      'Pinar de Chamartín',
    ]);
    expect(line.directions[0].stops[1]).toMatchObject({ code: '4_250', name: 'Iglesia' });
  });

  it('timetable de línea de catálogo: 200 con first/last null, 0 trips y mensaje sin horarios', async () => {
    const res = await app.request('/crtm/lines/timetable/4__1_____', {}, envCatalog());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.message).toContain('Sin horarios oficiales');
    const line = body.data.lines[0];
    expect(line.noSchedule).toEqual({ calendarEnd: '20260527', feedVersions: ['20250527'] });
    expect(line.directions).toHaveLength(2);
    expect(line.directions[0]).toMatchObject({ first: null, last: null, trips: 0, services: [] });
    expect(line.directions.map((d: { headsign: string }) => d.headsign)).toEqual([
      'Valdecarros',
      'Pinar de Chamartín',
    ]);
  });

  it('status muestra el feed como catalogOnly', async () => {
    const res = await app.request('/crtm/status', {}, envCatalog());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.versions.metro.catalogOnly).toBe('calendario caducado (20260527)');
  });
});

describe('GET /crtm/stops/schedule/:stopCode', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date(CRTM_TEST_NOW));
  });

  it('devuelve las próximas salidas teóricas ordenadas (madrugadas ≥24:00, excepciones y colisiones de label)', async () => {
    const res = await app.request('/crtm/stops/schedule/09568', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.stopCode).toBe('09568');
    expect(body.data.date).toBe('2026-08-20');
    expect(body.data.windowMin).toBe(120);
    expect(body.data.stop.municipality).toBe('Madrid');

    expect(body.data.departures.map((d: { time: string }) => d.time)).toEqual([
      '10:25',
      '10:30',
      '11:00',
      '11:05',
      '11:10',
    ]);
    expect(body.data.departures[2]).toMatchObject({
      routeId: '9__421___',
      network: 'urban',
      headsign: 'Estación de Alcorcón',
    });
    expect(body.data.departures.every((d: { dayOffset: number }) => d.dayOffset === 0)).toBe(true);

    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=300');
  });

  it('respeta el parámetro window', async () => {
    const res = await app.request('/crtm/stops/schedule/09568?window=12', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.windowMin).toBe(12);
    expect(body.data.departures.map((d: { time: string }) => d.time)).toEqual(['10:25']);
  });

  it('parada sin docs de línea en KV devuelve 200 con count 0', async () => {
    const res = await app.request('/crtm/stops/schedule/08712', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.count).toBe(0);
  });

  it('feed con sábado truncado: sirve la última generación caducada y marca calendarFallback', async () => {
    vi.setSystemTime(new Date('2026-08-29T08:15:00Z')); // sábado 29/08/2026 10:15 Madrid
    const doc: CRTMLineDoc = {
      routeId: '9__1__013_',
      label: '1',
      name: 'Urbano Alcorcón',
      network: 'urban',
      municipality: 'Alcorcón',
      url: null,
      directions: [{ id: 0, headsign: 'Centro', stops: ['08712'] }],
      services: [
        {
          id: 'LAB',
          days: [1, 1, 1, 1, 1, 0, 0],
          from: '20260722',
          to: '20270730',
          exceptions: {},
        },
        {
          id: 'SAB',
          days: [0, 0, 0, 0, 0, 1, 0],
          from: '20260725',
          to: '20260725',
          exceptions: {},
        },
      ],
      trips: [
        { dir: 0, svc: 1, headsign: 'Centro', dep: 10 * 3600 + 30 * 60, stops: ['08712@0'] },
        { dir: 0, svc: 0, headsign: 'Centro', dep: 11 * 3600, stops: ['08712@0'] },
      ],
    };
    const env = seedCRTM(mockKV(), crtmScheduleDocsFixture().concat(doc));

    const res = await app.request('/crtm/stops/schedule/08712', {}, env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(1);
    expect(body.data.calendarFallback).toBe(true);
    expect(body.data.departures[0]).toMatchObject({
      routeId: '9__1__013_',
      time: '10:30',
      stale: true,
    });
  });

  it('cabecera: solo salidas hacia la otra cabecera, con destino de cabecera en schedule/detail/timetable', async () => {
    vi.setSystemTime(new Date('2026-08-29T18:00:00Z')); // sábado 29/08/2026 20:00 Madrid
    const kv = mockKV();
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([
        {
          code: '20789',
          name: 'FERNANDO FERNÁN GÓMEZ-EST.LA GARENA',
          address: 'Acces Posterior 1',
          lat: 40.479768,
          lon: -3.392603,
          zone: 'B3',
          municipality: 'Alcalá de Henares',
          lines: ['6'],
        },
        {
          code: '20795',
          name: 'CARRETERA DE VALLADOLID-KM.1',
          address: 'Ctra Valladolid 1',
          lat: 40.48,
          lon: -3.4,
          zone: 'B3',
          municipality: 'Alcalá de Henares',
          lines: ['6'],
        },
        {
          code: '20790',
          name: 'AV. VIRGEN DEL VAL-PZA. SANTOS NIÑOS',
          address: 'Av. Virgen del Val 2',
          lat: 40.482,
          lon: -3.395,
          zone: 'B3',
          municipality: 'Alcalá de Henares',
          lines: ['6'],
        },
      ]),
    );
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify({
        count: 1,
        lines: [
          {
            label: '6',
            routeId: '9__6__005_',
            name: 'EST. LA GARENA - VIRGEN DEL VAL',
            network: 'urban',
            municipality: 'Alcalá de Henares',
            url: null,
          },
        ],
      }),
    );
    kv.set(
      `${CRTM_CONFIG.CACHE_KEYS.LINE_PREFIX}9__6__005_`,
      JSON.stringify({
        routeId: '9__6__005_',
        label: '6',
        name: 'EST. LA GARENA - VIRGEN DEL VAL',
        network: 'urban',
        municipality: 'Alcalá de Henares',
        url: null,
        directions: [
          { id: 0, headsign: 'ÁVILA-MURCIA', stops: ['20789', '20795', '20790'] },
          {
            id: 1,
            headsign: 'FERNANDO FERNÁN GÓMEZ-EST.LA GARENA',
            stops: ['20790', '20795', '20789'],
          },
        ],
        services: [
          {
            id: 'TODOS',
            days: [1, 1, 1, 1, 1, 1, 1],
            from: '20260801',
            to: '20260901',
            exceptions: {},
          },
        ],
        trips: [
          {
            dir: 0,
            svc: 0,
            headsign: 'ÁVILA-MURCIA',
            dep: 20 * 3600 + 30 * 60,
            stops: ['20789@0', '20795@600', '20790@1200'],
          },
          {
            dir: 1,
            svc: 0,
            headsign: 'FERNANDO FERNÁN GÓMEZ-EST.LA GARENA',
            dep: 21 * 3600,
            stops: ['20790@0', '20795@600', '20789@1200'],
          },
        ],
      }),
    );
    kv.set(CRTM_CONFIG.CACHE_KEYS.META, JSON.stringify(crtmMetaFixture()));
    const env = mockEnv(kv);

    const schedule = await jsonBody(
      await app.request('/crtm/stops/schedule/20789?window=240', {}, env),
    );
    expect(schedule.data.count).toBe(1);
    expect(schedule.data.departures[0]).toMatchObject({
      dir: 0,
      time: '20:30',
      headsign: 'VIRGEN DEL VAL',
    });

    const detail = await jsonBody(await app.request('/crtm/lines/detail/9__6__005_', {}, env));
    expect(detail.data.lines[0].directions.map((d: { headsign: string }) => d.headsign)).toEqual([
      'VIRGEN DEL VAL',
      'EST. LA GARENA',
    ]);

    const timetable = await jsonBody(
      await app.request('/crtm/lines/timetable/9__6__005_', {}, env),
    );
    expect(timetable.data.lines[0].directions.map((d: { headsign: string }) => d.headsign)).toEqual(
      ['VIRGEN DEL VAL', 'EST. LA GARENA'],
    );
  });

  it('dest por trip: schedule usa el dest de cada expedición y detail/timetable el mode(dest)', async () => {
    vi.setSystemTime(new Date('2026-08-29T18:00:00Z')); // sábado 29/08/2026 20:00 Madrid
    const kv = mockKV();
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([
        {
          code: '10001',
          name: 'ESTACIÓN SUR DE AUTOBUSES',
          address: 'Calle Méndez Álvaro 83',
          lat: 40.4,
          lon: -3.7,
          zone: 'A',
          municipality: 'Madrid',
          lines: ['423'],
        },
      ]),
    );
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify({
        count: 1,
        lines: [
          {
            label: '423',
            routeId: '8__423___',
            name: 'MADRID (Estación Sur)-ARANJUEZ',
            network: 'interurban',
            municipality: 'Aranjuez',
            url: null,
          },
        ],
      }),
    );
    kv.set(
      `${CRTM_CONFIG.CACHE_KEYS.LINE_PREFIX}8__423___`,
      JSON.stringify({
        routeId: '8__423___',
        label: '423',
        name: 'MADRID (Estación Sur)-ARANJUEZ',
        network: 'interurban',
        municipality: 'Aranjuez',
        url: null,
        directions: [{ id: 1, headsign: 'ESTACIÓN SUR DE AUTOBUSES', stops: ['10001'] }],
        services: [
          {
            id: 'TODOS',
            days: [1, 1, 1, 1, 1, 1, 1],
            from: '20260801',
            to: '20260901',
            exceptions: {},
          },
        ],
        trips: [
          {
            dir: 1,
            svc: 0,
            headsign: 'ESTACIÓN SUR DE AUTOBUSES',
            dest: 'MADRID (Estación Sur)',
            dep: 20 * 3600 + 30 * 60,
            stops: ['10001@0'],
          },
          {
            dir: 1,
            svc: 0,
            headsign: 'ESTACIÓN SUR DE AUTOBUSES',
            dest: 'MADRID (Legazpi)',
            dep: 20 * 3600 + 50 * 60,
            stops: ['10001@0'],
          },
          {
            dir: 1,
            svc: 0,
            headsign: 'ESTACIÓN SUR DE AUTOBUSES',
            dest: 'MADRID (Legazpi)',
            dep: 21 * 3600 + 10 * 60,
            stops: ['10001@0'],
          },
        ],
      }),
    );
    kv.set(CRTM_CONFIG.CACHE_KEYS.META, JSON.stringify(crtmMetaFixture()));
    const env = mockEnv(kv);

    const schedule = await jsonBody(
      await app.request('/crtm/stops/schedule/10001?window=120', {}, env),
    );
    expect(schedule.data.departures.map((d: { headsign: string }) => d.headsign)).toEqual([
      'MADRID (Estación Sur)',
      'MADRID (Legazpi)',
      'MADRID (Legazpi)',
    ]);

    // la cabecera heurística habría dado 'MADRID (Estación Sur)': gana el dest modal de los trips
    const detail = await jsonBody(await app.request('/crtm/lines/detail/8__423___', {}, env));
    expect(detail.data.lines[0].directions[0].headsign).toBe('MADRID (Legazpi)');

    const timetable = await jsonBody(await app.request('/crtm/lines/timetable/8__423___', {}, env));
    expect(timetable.data.lines[0].directions[0].headsign).toBe('MADRID (Legazpi)');
  });

  it('parada ml (10_5): salidas con network ml y código namespacelado', async () => {
    const res = await app.request('/crtm/stops/schedule/10_5', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(1);
    expect(body.data.departures[0]).toMatchObject({
      line: 'ML2',
      routeId: '10__ML2___',
      network: 'ml',
      headsign: 'Colonia Jardín',
      time: '10:35',
      dayOffset: 0,
    });
  });

  it('devuelve 400 con stopCode o window inválidos', async () => {
    const env = envSchedule();

    const badCode = await app.request('/crtm/stops/schedule/09-568', {}, env);
    const badWindow = await app.request('/crtm/stops/schedule/09568?window=abc', {}, env);
    const tooBig = await app.request('/crtm/stops/schedule/09568?window=400', {}, env);
    const tooLong = await app.request('/crtm/stops/schedule/12345678901234567', {}, env);

    expect(badCode.status).toBe(400);
    expect(badWindow.status).toBe(400);
    expect(tooBig.status).toBe(400);
    expect(tooLong.status).toBe(400);
  });

  it('código de 11-16 chars con formato válido: 404, no 400 (B-1: valida contra stops:all)', async () => {
    const res = await app.request('/crtm/stops/schedule/12345678901', {}, envSchedule());

    expect(res.status).toBe(404);
    expect((await jsonBody(res)).message).toContain('No existe la parada CRTM 12345678901');
  });

  it('devuelve 404 para una parada inexistente', async () => {
    const res = await app.request('/crtm/stops/schedule/00001', {}, envSchedule());

    expect(res.status).toBe(404);
    const body = await jsonBody(res);
    expect(body.message).toContain('No existe la parada CRTM 00001');
  });

  it('devuelve 503 si lines:all no está cargado', async () => {
    const kv = mockKV();
    kv.set(CRTM_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(crtmStopsFixture()));
    const res = await app.request('/crtm/stops/schedule/09568', {}, mockEnv(kv));

    expect(res.status).toBe(503);
  });
});

describe('GET /crtm/stops/schedule/:stopCode?date= (modo fecha: día completo)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date(CRTM_TEST_NOW)); // jueves 20/08/2026 10:15 Madrid
  });

  it('tablón del día completo para mañana: madrugada del servicio de hoy, sin windowMin y cacheable', async () => {
    const res = await app.request('/crtm/stops/schedule/09568?date=2026-08-21', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.date).toBe('2026-08-21');
    expect(body.data.windowMin).toBeUndefined();
    expect(body.message).toContain('21/08/2026');

    // 10:30 = madrugada ≥24:00 del servicio del jueves; el REFORZADO corre el viernes y el FESTIVO no
    expect(body.data.departures.map((d: { time: string }) => d.time)).toEqual([
      '10:25',
      '10:30',
      '10:55',
      '11:00',
      '11:05',
      '13:15',
    ]);
    expect(body.data.departures.every((d: { dayOffset: number }) => d.dayOffset === 0)).toBe(true);
    expect(body.data.departures[3]).toMatchObject({ routeId: '9__421___', network: 'urban' });

    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=3600');
  });

  it('date=hoy: incluye las salidas ya pasadas y aplica las excepciones del día', async () => {
    const res = await app.request('/crtm/stops/schedule/09568?date=2026-08-20', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.departures.map((d: { time: string }) => d.time)).toEqual([
      '10:25',
      '10:30',
      '11:00',
      '11:05',
      '11:10',
      '13:15',
    ]);
    expect(body.data.departures.some((d: { time: string }) => d.time === '10:55')).toBe(false); // REFORZADO retirado hoy
  });

  it('line= filtra por label en modo fecha', async () => {
    const env = envSchedule();

    const ml2 = await jsonBody(
      await app.request('/crtm/stops/schedule/10_5?date=2026-08-21&line=ML2', {}, env),
    );
    expect(ml2.data.count).toBe(1);
    expect(ml2.data.departures[0]).toMatchObject({
      line: 'ML2',
      routeId: '10__ML2___',
      time: '10:35',
    });

    const none = await jsonBody(
      await app.request('/crtm/stops/schedule/10_5?date=2026-08-21&line=421', {}, env),
    );
    expect(none.data.count).toBe(0);
  });

  it('window se ignora cuando hay date (sin 400)', async () => {
    const res = await app.request(
      '/crtm/stops/schedule/09568?date=2026-08-21&window=abc',
      {},
      envSchedule(),
    );

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.windowMin).toBeUndefined();
    expect(body.data.count).toBeGreaterThan(0);
  });

  it('fecha más allá del calendario publicado: fallback de última generación con stale y calendarFallback', async () => {
    // los docs fixture publican hasta 2026-08-27: el 03/09 (jueves) se sirve con la última
    // generación del jueves conocida, marcada stale — mismo criterio que el feed truncado
    const res = await app.request('/crtm/stops/schedule/09568?date=2026-09-03', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(6);
    expect(body.data.calendarFallback).toBe(true);
    expect(body.data.departures.every((d: { stale?: true }) => d.stale === true)).toBe(true);
    expect(body.message).toContain('03/09/2026');
  });

  it('devuelve 400 con date en formato inválido, fecha inexistente o fuera de [hoy, hoy+14]', async () => {
    const env = envSchedule();

    const badFormat1 = await app.request('/crtm/stops/schedule/09568?date=21-08-2026', {}, env);
    const badFormat2 = await app.request('/crtm/stops/schedule/09568?date=20260821', {}, env);
    const notReal = await app.request('/crtm/stops/schedule/09568?date=2026-02-30', {}, env);
    const past = await app.request('/crtm/stops/schedule/09568?date=2026-08-19', {}, env);
    const tooFar = await app.request('/crtm/stops/schedule/09568?date=2026-09-04', {}, env);

    expect(badFormat1.status).toBe(400);
    expect(badFormat2.status).toBe(400);
    expect(notReal.status).toBe(400);
    expect(past.status).toBe(400);
    expect(tooFar.status).toBe(400);
  });

  it('estación de red en catálogo: 200 con noScheduleData y sin salidas', async () => {
    const kv = mockKV();
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([
        {
          code: '4_250',
          name: 'Iglesia',
          address: 'Calle de la Iglesia 3',
          lat: 40.4189,
          lon: -3.7048,
          zone: 'A',
          municipality: 'Madrid',
          lines: ['1'],
        },
      ]),
    );
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify({
        count: 1,
        lines: [
          {
            label: '1',
            routeId: '4__1_____',
            name: 'Pinar de Chamartín - Valdecarros',
            network: 'metro',
            municipality: 'Madrid',
            url: null,
            color: '58ABE8',
            textColor: 'FFFFFF',
            noSchedule: true,
          },
        ],
      }),
    );
    kv.set(
      `${CRTM_CONFIG.CACHE_KEYS.LINE_PREFIX}4__1_____`,
      JSON.stringify({
        routeId: '4__1_____',
        label: '1',
        name: 'Pinar de Chamartín - Valdecarros',
        network: 'metro',
        municipality: 'Madrid',
        url: null,
        color: '58ABE8',
        textColor: 'FFFFFF',
        noSchedule: { calendarEnd: '20260527', feedVersions: ['20250527'] },
        directions: [
          { id: 0, headsign: 'Valdecarros', stops: ['4_263', '4_250', '4_261'] },
          { id: 1, headsign: 'Pinar de Chamartín', stops: ['4_261', '4_250', '4_263'] },
        ],
      }),
    );
    const env = mockEnv(kv);

    const res = await app.request('/crtm/stops/schedule/4_250?date=2026-08-21', {}, env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(0);
    expect(body.data.noScheduleData).toEqual({
      networks: ['metro'],
      calendarEnd: '20260527',
      feedVersions: ['20250527'],
    });
    expect(body.message).toContain('27/05/2026');
  });
});

describe('GET /crtm/lines/route/:routeId', () => {
  function envRoute() {
    const kv = mockKV();
    const r2 = mockR2();
    const env = seedCRTM(kv, crtmScheduleDocsFixture());
    r2.set(
      `${CRTM_CONFIG.SHAPES_OBJECT_PREFIX}8__421___.json`,
      JSON.stringify(crtmRouteDocFixture()),
    );
    return { ...env, CRTM_SHAPES: r2 } as typeof env;
  }

  it('devuelve el doc GeoJSON por routeId exacto (MultiLineString por dirección, id/headsign como detail)', async () => {
    const res = await app.request('/crtm/lines/route/8__421___', {}, envRoute());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.routeId).toBe('8__421___');
    expect(body.data.directions).toHaveLength(2);
    expect(body.data.directions[0]).toMatchObject({
      id: 0,
      headsign: 'Madrid (Moncloa)',
      shapeId: 'S-421-A',
    });
    expect(body.data.directions[1].geometry.type).toBe('MultiLineString');
    expect(body.data.directions[1].geometry.coordinates).toHaveLength(2);
    expect(body.data.bounds).toEqual([-3.7418, 40.4281, -3.8257, 40.4295]);
    expect(body.data.toleranceM).toBe(1.5);

    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=3600');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('404 distinto para routeId inexistente vs línea sin geometría', async () => {
    const env = envRoute();

    const notFound = await app.request('/crtm/lines/route/8__999___', {}, env);
    const noGeometry = await app.request('/crtm/lines/route/9__1__013_', {}, env); // está en lines:all pero sin objeto R2

    expect(notFound.status).toBe(404);
    expect((await jsonBody(notFound)).message).toContain('No existe la línea CRTM 8__999___');
    expect(noGeometry.status).toBe(404);
    expect((await jsonBody(noGeometry)).message).toContain('no tiene geometría');
  });

  it('no resuelve labels: el label 421 sin routeId exacto es 404', async () => {
    const res = await app.request('/crtm/lines/route/421', {}, envRoute());

    expect(res.status).toBe(404);
    expect((await jsonBody(res)).message).toContain('No existe la línea CRTM 421');
  });

  it('devuelve 400 con routeId inválido', async () => {
    const res = await app.request('/crtm/lines/route/4%21x%20y', {}, envRoute());

    expect(res.status).toBe(400);
  });

  it('devuelve 503 si lines:all no está cargado o R2 falla', async () => {
    const kv = mockKV();
    kv.set(CRTM_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(crtmStopsFixture()));
    const noLinesAll = await app.request('/crtm/lines/route/8__421___', {}, mockEnv(kv));

    expect(noLinesAll.status).toBe(503);

    const env = envRoute();
    const failingR2 = {
      get: () => Promise.reject(new Error('r2 down')),
    };
    // R2 "failing" a propósito: el cast doble declara la intención (parcial de R2Bucket)
    const envFailing = { ...env, CRTM_SHAPES: failingR2 } as unknown as typeof env;
    const r2Down = await app.request('/crtm/lines/route/8__421___', {}, envFailing);

    expect(r2Down.status).toBe(503);
    expect(r2Down.headers.get('Retry-After')).toBe('300');
  });
});

describe('GET /crtm/status', () => {
  it('devuelve el meta del pipeline con atribución', async () => {
    const res = await app.request('/crtm/status', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.generatedAt).toBe('2026-08-19T05:41:00.000Z');
    expect(body.data.versions.interurban.feedVersions).toEqual(['2026.7.26']);
    expect(body.data.versions.ml.feedVersions).toEqual(['2026.7.22']);
    expect(body.data.counts.stopsKept).toBe(8055);
    expect(body.data.counts.lineDocs.ml).toBe(4);
    expect(body.data.shapes.bucket).toBe('madmovil-crtm-shapes');
    expect(body.data.attribution).toContain('CRTM');
  });

  it('devuelve 503 si crtm:meta no existe (carga inicial pendiente)', async () => {
    const res = await app.request('/crtm/status', {}, envSchedule(false));

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('300');
  });
});

describe('rate limiting /crtm/*', () => {
  it('grupo crtm independiente con clave crtm:ip y 429 al superar el límite', async () => {
    const kv = mockKV();
    seedCRTM(kv, crtmScheduleDocsFixture());
    kv.set(
      EMT_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([
        {
          stopId: '123',
          name: 'Plaza de España',
          coordinates: { latitude: 1, longitude: 2 },
          lines: ['1'],
        },
      ]),
    );
    const limiter = mockRateLimiter(1);
    const env = mockEnv(kv, limiter);

    const first = await app.request(
      '/crtm/stops/search?stopId=09568',
      { headers: { 'cf-connecting-ip': '5.6.7.8' } },
      env,
    );
    const second = await app.request(
      '/crtm/stops/search?stopId=09568',
      { headers: { 'cf-connecting-ip': '5.6.7.8' } },
      env,
    );
    const stopsRoute = await app.request('/stops/search?stopId=123', {}, env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBe('60');
    expect(limiter.calls).toEqual(['crtm:5.6.7.8', 'crtm:5.6.7.8', 'stops:unknown']);
    expect(stopsRoute.status).toBe(200); // el grupo stops tiene contador aparte
  });
});

// ---------- Cercanías Renfe (network cercanias, artefactos del pipeline NAP) ----------

function envCercanias() {
  const kv = mockKV();
  kv.set(CRTM_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(crtmCercaniasStopsFixture()));
  kv.set(CRTM_CONFIG.CACHE_KEYS.LINES_ALL, JSON.stringify(crtmCercaniasLinesAllFixture()));
  for (const doc of crtmCercaniasDocsFixture()) {
    kv.set(`${CRTM_CONFIG.CACHE_KEYS.LINE_PREFIX}${doc.routeId}`, JSON.stringify(doc));
  }
  kv.set(CRTM_CONFIG.CACHE_KEYS.META, JSON.stringify(crtmMetaFixture()));
  return mockEnv(kv);
}

describe('GET /crtm/* con Cercanías (códigos r_*, dest por trip, services de un día)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date(CRTM_TEST_NOW));
  });

  it('schedule de estación r_18000: headsign = dest (última estación del trip)', async () => {
    const res = await app.request('/crtm/stops/schedule/r_18000', {}, envCercanias());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.stop.name).toBe('Madrid-Atocha Cercanías');
    // 10:22 hacia Móstoles-El Soto (salida de Atocha), 10:46 hacia Humanes (trip desde Doce de Octubre)
    // y 10:55 hacia Móstoles-El Soto (trip extra para el overlay GTFS-RT)
    expect(body.data.departures.map((d: { time: string }) => d.time)).toEqual([
      '10:22',
      '10:46',
      '10:55',
    ]);
    expect(body.data.departures[0]).toMatchObject({
      line: 'C5',
      routeId: '10T_C5',
      network: 'cercanias',
      headsign: 'Móstoles-El Soto',
      dir: 0,
      dayOffset: 0,
    });
    expect(body.data.departures[1].headsign).toBe('Humanes');
    // el trip de madrugada del viernes (25:15 del servicio de mañana) queda fuera de la ventana
    expect(body.data.departures).toHaveLength(3);
  });

  it('search por código namespacelado r_18000 y por nombre de estación', async () => {
    const env = envCercanias();

    const byCode = await app.request('/crtm/stops/search?stopId=r_18000', {}, env);
    expect(byCode.status).toBe(200);
    const byCodeBody = await jsonBody(byCode);
    expect(byCodeBody.data.count).toBe(1);
    expect(byCodeBody.data.stops[0].name).toBe('Madrid-Atocha Cercanías');
    expect(byCodeBody.data.stops[0].lines).toEqual(['C5']);

    const byName = await app.request('/crtm/stops/search?name=atocha cercanias', {}, env);
    expect((await jsonBody(byName)).data.count).toBe(1);
  });

  it('chips: línea cercanias con color/textColor del feed', async () => {
    const res = await app.request('/crtm/lines', {}, envCercanias());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    const c5 = body.data.lines.find((l: { label: string }) => l.label === 'C5');
    expect(c5).toMatchObject({
      routeId: '10T_C5',
      network: 'cercanias',
      color: 'FECB00',
      textColor: '000000',
    });
  });

  it('detail C5: headsigns de dirección = mode(dest) por trip (terminales reales)', async () => {
    const res = await app.request('/crtm/lines/detail/C5', {}, envCercanias());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.lines).toHaveLength(1);
    const line = body.data.lines[0];
    expect(line.network).toBe('cercanias');
    expect(line.tripCount).toBe(4);
    expect(line.url).toBeNull();
    expect(line.directions.map((d: { headsign: string }) => d.headsign)).toEqual([
      'Móstoles-El Soto',
      'Humanes',
    ]);
    // direcciones con la secuencia más larga (corredor completo) enriquecidas con nombre/coords
    expect(line.directions[0].stops.map((s: { code: string }) => s.code)).toEqual([
      'r_18123',
      'r_18000',
      'r_17100',
      'r_18125',
    ]);
    expect(line.directions[0].stops[0]).toMatchObject({
      code: 'r_18123',
      name: 'Humanes',
      lat: expect.any(Number),
    });
  });

  it('timetable C5: first/last/trips por dirección con services de un solo día', async () => {
    const res = await app.request('/crtm/lines/timetable/C5', {}, envCercanias());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    const line = body.data.lines[0];
    expect(line.directions.map((d: { id: number }) => d.id)).toEqual([0, 1]);
    expect(line.directions[0]).toMatchObject({
      first: '10:22',
      last: '10:55',
      trips: 3,
      headsign: 'Móstoles-El Soto',
    });
    expect(line.directions[1]).toMatchObject({
      first: '25:15',
      last: '25:15',
      trips: 1,
      headsign: 'Humanes',
    });
    expect(line.directions[0].services[0]).toMatchObject({ from: '20260820', to: '20260820' });
  });

  it('status: versions.cercanias con itemModified string (nombre/fecha de publicación NAP)', async () => {
    const res = await app.request('/crtm/status', {}, envCercanias());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.versions.cercanias).toMatchObject({
      itemModified: '2026-08-25T05:21:21Z',
      feedVersions: ['20260825'],
    });
    expect(body.data.attribution).toContain('Renfe');
  });
});

// ---------- /crtm/stops/arrivals (Cercanías tiempo real, GTFS-RT de Renfe) ----------

function envCercaniasWithDocs(docs: CRTMLineDoc[]) {
  const kv = mockKV();
  kv.set(CRTM_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(crtmCercaniasStopsFixture()));
  kv.set(CRTM_CONFIG.CACHE_KEYS.LINES_ALL, JSON.stringify(crtmCercaniasLinesAllFixture()));
  for (const doc of docs) {
    kv.set(`${CRTM_CONFIG.CACHE_KEYS.LINE_PREFIX}${doc.routeId}`, JSON.stringify(doc));
  }
  kv.set(CRTM_CONFIG.CACHE_KEYS.META, JSON.stringify(crtmMetaFixture()));
  return mockEnv(kv);
}

function rtFetchMock(nowMs = CRTM_TEST_NOW, opts: { stale?: boolean } = {}) {
  const { tripUpdates, vehiclePositions } = crtmRenfeRealtimeFixture(nowMs, opts);
  return vi.fn().mockImplementation((url: string | URL) => {
    const u = String(url);
    if (u === CRTM_CONFIG.RT.TRIP_UPDATES_URL)
      return Promise.resolve(new Response(JSON.stringify(tripUpdates), { status: 200 }));
    if (u === CRTM_CONFIG.RT.VEHICLE_POSITIONS_URL)
      return Promise.resolve(new Response(JSON.stringify(vehiclePositions), { status: 200 }));
    return Promise.reject(new Error(`URL inesperada: ${u}`));
  });
}

describe('GET /crtm/stops/arrivals/:stopCode (overlay GTFS-RT)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date(CRTM_TEST_NOW));
    __resetRealtimeCache();
  });

  afterEach(() => {
    __resetRealtimeCache();
  });

  it('tablón con retrasos, cancelación, andén, posición y refuerzos inyectados', async () => {
    vi.stubGlobal('fetch', rtFetchMock());

    const res = await app.request('/crtm/stops/arrivals/r_18000', {}, envCercanias());

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.stop.name).toBe('Madrid-Atocha Cercanías');
    expect(body.data.realtime).toMatchObject({
      available: true,
      feedTimestamp: new Date(CRTM_TEST_NOW).toISOString(),
    });
    expect(body.data.attribution).toContain('Renfe GTFS-RT');

    const deps = body.data.departures as Record<string, unknown>[];
    // 3 salidas teóricas (10:22, 10:46, 10:55) + 2 refuerzos SPECIAL (10:23 C5, 10:30 C3)
    expect(deps).toHaveLength(5);
    expect(deps.map((d) => d.line)).toEqual(['C5', 'C5', 'C3', 'C5', 'C5']);

    // refuerzo C5 (no está en el GTFS estático): added, sin dest, routeId resuelto por label
    expect(deps[0]).toMatchObject({
      line: 'C5',
      routeId: '10T_C5',
      dest: null,
      added: true,
      realtime: true,
      tripId: 'SPECIAL_10_99001C5',
      arrivesInMin: 8,
      platform: '2',
      trainId: '99001',
    });

    // 10:22 programado con llegada exacta del feed a las 10:26 (delay derivado 240) y andén 9
    expect(deps[1]).toMatchObject({
      line: 'C5',
      routeId: '10T_C5',
      dest: 'Móstoles-El Soto',
      dir: 0,
      realtime: true,
      tripId: '1041L19791C5',
      delaySec: 240,
      arrivesInMin: 11,
      platform: '9',
      trainId: '19791',
      accessible: true,
      trainStatus: 'INCOMING_AT',
      trainPosition: { latitude: 40.4008, longitude: -3.6826 },
    });

    // refuerzo C3: label no está entre los docs de la parada → routeId null
    expect(deps[2]).toMatchObject({
      line: 'C3',
      routeId: null,
      added: true,
      arrivesInMin: 15,
      platform: '0',
    });

    // 10:46 programado + delay global 60 (su próxima parada NO es Atocha) → 10:47
    expect(deps[3]).toMatchObject({
      tripId: '1041L19792C5',
      delaySec: 60,
      arrivesInMin: 32,
      dest: 'Humanes',
      accessible: false,
    });

    // tren cancelado: permanece en el tablón con flag (la UI decide cómo mostrarlo)
    expect(deps[4]).toMatchObject({
      tripId: '1041L19795C5',
      canceled: true,
      arrivesInMin: 40,
      platform: '10',
    });
  });

  it('filtro ?line= aplica a salidas teóricas y refuerzos', async () => {
    vi.stubGlobal('fetch', rtFetchMock());
    const env = envCercanias();

    const c3 = await app.request('/crtm/stops/arrivals/r_18000?line=C3', {}, env);
    const c3Body = await jsonBody(c3);
    expect(c3Body.data.count).toBe(1);
    expect(c3Body.data.departures[0].line).toBe('C3');

    const c5 = await app.request('/crtm/stops/arrivals/r_18000?line=C5', {}, env);
    const c5Body = await jsonBody(c5);
    expect(c5Body.data.count).toBe(4);
  });

  it('?line= filtra los docs ANTES del cap: la línea pedida cubre la ventana entera (C-10)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

    // 2 líneas × 70 salidas intercaladas cada 2 min = 140 candidatas > cap de 100:
    // filtrar DESPUÉS del cap recortaba la ventana de la línea pedida en silencio
    const wc = madridWallClock(CRTM_TEST_NOW);
    const svc: CRTMService = {
      id: 'CAP-SVC',
      days: [1, 1, 1, 1, 1, 1, 1],
      from: '20260101',
      to: '20261231',
      exceptions: {},
    };
    const mkDoc = (label: string, offsetSec: number): CRTMLineDoc => ({
      routeId: `10T_${label}`,
      label,
      name: `Corredor ${label}`,
      network: 'cercanias',
      municipality: 'Madrid',
      url: null,
      directions: [{ id: 0, headsign: 'Destino', stops: ['r_18000', 'r_19999'] }],
      services: [svc],
      trips: Array.from({ length: 70 }, (_, i) => ({
        dir: 0,
        svc: 0,
        headsign: '',
        dep: wc.secsOfDay + offsetSec + i * 120,
        stops: ['r_18000@0'],
      })),
    });
    const kv = mockKV();
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify(
        crtmCercaniasStopsFixture().map((s) =>
          s.code === 'r_18000' ? { ...s, lines: ['C5', 'C3'] } : s,
        ),
      ),
    );
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify({
        count: 3,
        lines: [
          ...crtmCercaniasLinesAllFixture().lines,
          {
            label: 'C3',
            routeId: '10T_C3',
            name: 'Corredor C3',
            network: 'cercanias',
            municipality: 'Madrid',
            url: null,
          },
        ],
      }),
    );
    for (const doc of [mkDoc('C5', 120), mkDoc('C3', 180)]) {
      kv.set(`${CRTM_CONFIG.CACHE_KEYS.LINE_PREFIX}${doc.routeId}`, JSON.stringify(doc));
    }
    kv.set(CRTM_CONFIG.CACHE_KEYS.META, JSON.stringify(crtmMetaFixture()));
    const env = mockEnv(kv);

    const all = await jsonBody(
      await app.request('/crtm/stops/arrivals/r_18000?window=180', {}, env),
    );
    expect(all.data.count).toBe(CRTM_CONFIG.SCHEDULE_MAX_RESULTS); // sin ?line=: el cap recorta las 140

    const c3 = await jsonBody(
      await app.request('/crtm/stops/arrivals/r_18000?window=180&line=C3', {}, env),
    );
    expect(c3.data.count).toBe(70);
    expect(c3.data.departures.every((d: { line: string }) => d.line === 'C3')).toBe(true);
    // la última de C3 (t+3+69×2 = 141 min) sigue dentro: antes el cap se lo comía con las C5
    expect(c3.data.departures[69].arrivesInMin).toBe(141);
  });

  it('feed RT caído → tablón teórico con realtime.available false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

    const res = await app.request('/crtm/stops/arrivals/r_18000', {}, envCercanias());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.realtime.available).toBe(false);
    expect(body.message).toContain('tiempo real no disponible');
    const deps = body.data.departures as Record<string, unknown>[];
    expect(deps).toHaveLength(3); // solo teóricas: sin overlay ni refuerzos
    expect(deps.every((d) => d.realtime === false)).toBe(true);
    expect(deps.every((d) => d.canceled === undefined && d.platform === undefined)).toBe(true);
    // el tripId del horario teórico sigue exponiéndose (contract del doc con tid)
    expect(deps[0]).toHaveProperty('tripId', '1041L19791C5');
  });

  it('feed RT congelado (header.timestamp antiguo) → degradado igual que caído', async () => {
    vi.stubGlobal('fetch', rtFetchMock(CRTM_TEST_NOW, { stale: true }));

    const res = await app.request('/crtm/stops/arrivals/r_18000', {}, envCercanias());

    const body = await jsonBody(res);
    expect(body.data.realtime.available).toBe(false);
    expect(body.data.count).toBe(3);
  });

  it('docs sin tid (pre-materialización) → tablón teórico puro + refuerzos del RT', async () => {
    vi.stubGlobal('fetch', rtFetchMock());
    const docs = crtmCercaniasDocsFixture().map((doc) => ({
      ...doc,
      trips: doc.trips!.map(({ tid, ...trip }) => trip),
    }));

    const res = await app.request('/crtm/stops/arrivals/r_18000', {}, envCercaniasWithDocs(docs));

    const body = await jsonBody(res);
    // RT fresco pero sin tid el join es imposible: 3 teóricas sin overlay + 3 RT whose
    // próxima parada ES Atocha (2 refuerzos SPECIAL + el 1041L19791C5, que sin join no se
    // puede emparejar con su salida teórica y aparece como added)
    expect(body.data.realtime.available).toBe(true);
    const deps = body.data.departures as Record<string, unknown>[];
    expect(deps).toHaveLength(6);
    const theoretical = deps.filter((d) => d.added === undefined);
    expect(theoretical).toHaveLength(3);
    expect(theoretical.every((d) => d.realtime === false && d.tripId === undefined)).toBe(true);
  });

  it('validaciones: código inválido, estación inexistente y ventana', async () => {
    vi.stubGlobal('fetch', rtFetchMock());
    const env = envCercanias();

    const invalid = await app.request('/crtm/stops/arrivals/r-18000', {}, env);
    expect(invalid.status).toBe(400);
    expect((await jsonBody(invalid)).message).toContain('stopCode inválido');

    const tooLong = await app.request('/crtm/stops/arrivals/abcdefghijklmnopq', {}, env);
    expect(tooLong.status).toBe(400);

    // 11-16 chars con formato válido: 404, no 400 (B-1: la existencia valida contra stops:all)
    const longUnknown = await app.request('/crtm/stops/arrivals/12345678901', {}, env);
    expect(longUnknown.status).toBe(404);
    expect((await jsonBody(longUnknown)).message).toContain('No existe la parada CRTM');

    const unknown = await app.request('/crtm/stops/arrivals/r_99999', {}, env);
    expect(unknown.status).toBe(404);
    expect((await jsonBody(unknown)).message).toContain('No existe la parada CRTM');

    for (const bad of ['5', '999']) {
      const res = await app.request(`/crtm/stops/arrivals/r_18000?window=${bad}`, {}, env);
      expect(res.status).toBe(400);
    }
  });
});

// ---------- /crtm/stops/arrivals bus/ML/metro (widget oficial del CRTM) ----------

function widgetFetchMock(nowMs = CRTM_TEST_NOW, opts: { frozen?: boolean } = {}) {
  const times = crtmWidgetStopTimesFixture(nowMs, opts);
  const stops = crtmWidgetGetStopsFixture();
  return vi.fn().mockImplementation((url: string | URL) => {
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
}

function envWidget() {
  const kv = mockKV();
  kv.set(CRTM_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(crtmStopsFixture()));
  kv.set(CRTM_CONFIG.CACHE_KEYS.LINES_ALL, JSON.stringify(crtmLinesAllFixture()));
  for (const doc of crtmScheduleDocsFixture()) {
    kv.set(`${CRTM_CONFIG.CACHE_KEYS.LINE_PREFIX}${doc.routeId}`, JSON.stringify(doc));
  }
  kv.set(CRTM_CONFIG.CACHE_KEYS.META, JSON.stringify(crtmMetaFixture()));
  return { env: mockEnv(kv), kv };
}

// Estación de metro en modo catálogo (feed M4 stale): la parada existe y su doc no tiene
// horarios — el board del widget debe funcionar igualmente (el caso estrella de esta fase)
function envMetroCatalog() {
  const kv = mockKV();
  kv.set(
    CRTM_CONFIG.CACHE_KEYS.STOPS_ALL,
    JSON.stringify([
      ...crtmStopsFixture(),
      {
        code: '4_263',
        name: 'Pinar de Chamartín',
        address: null,
        lat: 40.4966,
        lon: -3.6694,
        zone: null,
        municipality: 'Madrid',
        lines: ['1'],
      },
    ]),
  );
  const lines = [
    ...crtmLinesAllFixture().lines,
    {
      label: '1',
      routeId: '4__1_____',
      name: 'Metro L1 Pinar de Chamartín - Valdecarros',
      network: 'metro' as const,
      municipality: 'Madrid',
      url: null,
      noSchedule: true as const,
    },
  ];
  kv.set(CRTM_CONFIG.CACHE_KEYS.LINES_ALL, JSON.stringify({ count: lines.length, lines }));
  kv.set(
    `${CRTM_CONFIG.CACHE_KEYS.LINE_PREFIX}4__1_____`,
    JSON.stringify({
      routeId: '4__1_____',
      label: '1',
      name: 'Metro L1 Pinar de Chamartín - Valdecarros',
      network: 'metro',
      municipality: 'Madrid',
      url: null,
      directions: [{ id: 0, headsign: 'Valdecarros', stops: ['4_263'] }],
      noSchedule: { calendarEnd: '20260527', feedVersions: ['v20250527'] },
    }),
  );
  kv.set(CRTM_CONFIG.CACHE_KEYS.META, JSON.stringify(crtmMetaFixture()));
  return { env: mockEnv(kv), kv };
}

describe('GET /crtm/stops/arrivals/:stopCode (widget CRTM: bus/ML/metro)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date(CRTM_TEST_NOW));
    __resetWidgetCache();
  });

  afterEach(() => {
    __resetWidgetCache();
    vi.unstubAllGlobals();
  });

  it('tablón de bus interurbano: SAE por línea, dest/dir normalizados, window y ya-efectivas filtradas', async () => {
    vi.stubGlobal('fetch', widgetFetchMock());

    const res = await app.request('/crtm/stops/arrivals/09568', {}, envWidget().env);

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.stop.name).toBe('Pº Extremadura - Av. Portugal');
    expect(body.data.realtime).toMatchObject({
      available: true,
      source: 'crtm-widget',
      feedTimestamp: new Date(CRTM_TEST_NOW).toISOString(),
    });
    expect(body.data.attribution).toContain('widget oficial del CRTM');

    const deps = body.data.departures as Record<string, unknown>[];
    // +90 min (fuera de window 60) y -60 s (ya efectiva) quedan fuera
    expect(deps).toHaveLength(3);
    // dest canónico (mode(dest) > cabecera, como detail/timetable): el dest del SAE
    // ("INTERCAMBIADOR DE MONCLOA" = terminal del sentido) se reescribe por la cabecera
    expect(deps[0]).toMatchObject({
      line: '421',
      routeId: '8__421___',
      network: 'interurban',
      dest: 'Moncloa',
      dir: 0,
      arrivesInMin: 5,
      time: '10:20',
      realtime: true,
      dayOffset: 0,
    });
    expect(deps[0].scheduledISO).toBeNull();
    expect(deps[0].estimatedISO).toBe(new Date(CRTM_TEST_NOW + 300_000).toISOString());
    // SAEStatus false → hora teórica de esa línea
    expect(deps[1]).toMatchObject({
      line: '211',
      routeId: '8__211___',
      realtime: false,
      arrivesInMin: 12,
    });
    // direction 2 del widget → dir 1 GTFS, con vehículo
    expect(deps[2]).toMatchObject({
      line: '421',
      dir: 1,
      arrivesInMin: 35,
      vehicle: 'E-1234',
      dest: 'Boadilla del Monte',
    });
  });

  it('dest canónico en el board RT: mode(dest) por dirección; la variante corta conserva su dest', async () => {
    // 6 de Alcalá de Henares (9__6__005_): el SAE manda como dest la calle de la cabecera
    // ("ÁVILA-MURCIA" / "FERNANDO FERNÁN GÓMEZ-EST.LA GARENA") y los trips del GTFS llevan el
    // itinerario oficial en dest (trip_short_name) — el board muestra el oficial, igual que
    // la ficha de línea; el refuerzo que acaba en parada intermedia conserva su dest real
    const nowMs = CRTM_TEST_NOW;
    const iso = (offsetSec: number) => new Date(nowMs + offsetSec * 1000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string | URL) => {
        const u = new URL(String(url));
        if (u.pathname.endsWith(CRTM_CONFIG.WIDGET.GET_STOP)) {
          const codStop = u.searchParams.get('codStop') ?? '';
          const body = codStop === '9_06994' ? { stops: { Stop: { codStop } } } : { stops: {} };
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        }
        const codStop = u.searchParams.get('codStop') ?? '';
        const body =
          codStop === '9_06994'
            ? {
                stopTimes: {
                  actualDate: iso(0),
                  stop: { codStop: '9_06994', name: 'AV.REYES CATÓLICOS-VIVEROS' },
                  times: {
                    Time: [
                      {
                        line: {
                          codLine: '9__6__005_',
                          shortDescription: '6',
                          description: '06-EST. LA GARENA - VIRGEN DEL VAL',
                          codMode: '9',
                        },
                        direction: 1,
                        destination: 'VIRGEN DEL VAL',
                        destinationStop: { codStop: '9_06993', name: 'ÁVILA-MURCIA' },
                        time: iso(300),
                        codVehicle: '',
                        codIssue: '',
                      },
                      {
                        line: {
                          codLine: '9__6__005_',
                          shortDescription: '6',
                          description: '06-EST. LA GARENA - VIRGEN DEL VAL',
                          codMode: '9',
                        },
                        direction: 2,
                        destination: 'EST. LA GARENA',
                        destinationStop: {
                          codStop: '9_06991',
                          name: 'FERNANDO FERNÁN GÓMEZ-EST.LA GARENA',
                        },
                        time: iso(900),
                        codVehicle: '',
                        codIssue: '',
                      },
                      {
                        line: {
                          codLine: '9__6__005_',
                          shortDescription: '6',
                          description: '06-EST. LA GARENA - VIRGEN DEL VAL',
                          codMode: '9',
                        },
                        direction: 1,
                        destination: 'VIRGEN DEL VAL',
                        destinationStop: { codStop: '9_06990', name: 'EST. ALCALÁ D. JUAN CARLOS' },
                        time: iso(1500),
                        codVehicle: '',
                        codIssue: '',
                      },
                    ],
                  },
                  linesStatus: {
                    LineStatus: {
                      line: { codLine: '9__6__005_', shortDescription: '6' },
                      SAEStatus: true,
                    },
                  },
                },
              }
            : {};
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );

    const kv = mockKV();
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.STOPS_ALL,
      JSON.stringify([
        ...crtmStopsFixture(),
        {
          code: '06994',
          name: 'AV.REYES CATÓLICOS-VIVEROS',
          address: null,
          lat: 40.482,
          lon: -3.36,
          zone: 'B1',
          municipality: 'Alcalá de Henares',
          lines: ['6'],
        },
        {
          code: '06993',
          name: 'ÁVILA-MURCIA',
          address: null,
          lat: 40.47,
          lon: -3.39,
          zone: 'B1',
          municipality: 'Alcalá de Henares',
          lines: ['6'],
        },
        {
          code: '06991',
          name: 'FERNANDO FERNÁN GÓMEZ-EST.LA GARENA',
          address: null,
          lat: 40.51,
          lon: -3.33,
          zone: 'B1',
          municipality: 'Alcalá de Henares',
          lines: ['6'],
        },
      ]),
    );
    kv.set(
      CRTM_CONFIG.CACHE_KEYS.LINES_ALL,
      JSON.stringify({
        count: crtmLinesAllFixture().count + 1,
        lines: [
          ...crtmLinesAllFixture().lines,
          {
            label: '6',
            routeId: '9__6__005_',
            name: 'EST. LA GARENA - VIRGEN DEL VAL',
            network: 'urban',
            municipality: 'Alcalá de Henares',
            url: null,
          },
        ],
      }),
    );
    kv.set(
      `${CRTM_CONFIG.CACHE_KEYS.LINE_PREFIX}9__6__005_`,
      JSON.stringify({
        routeId: '9__6__005_',
        label: '6',
        name: 'EST. LA GARENA - VIRGEN DEL VAL',
        network: 'urban',
        municipality: 'Alcalá de Henares',
        url: null,
        directions: [
          { id: 0, headsign: 'ÁVILA-MURCIA', stops: ['06994', '06993'] },
          {
            id: 1,
            headsign: 'FERNANDO FERNÁN GÓMEZ-EST.LA GARENA',
            stops: ['06993', '06994', '06991'],
          },
        ],
        services: [
          {
            id: 'LAB',
            days: [1, 1, 1, 1, 1, 1, 1],
            from: '20260813',
            to: '20260827',
            exceptions: {},
          },
        ],
        trips: [
          {
            dir: 0,
            svc: 0,
            headsign: 'ÁVILA-MURCIA',
            dest: 'VIRGEN DEL VAL',
            dep: 0,
            stops: ['06994@0', '06993@600'],
          },
          {
            dir: 1,
            svc: 0,
            headsign: 'FERNANDO FERNÁN GÓMEZ-EST.LA GARENA',
            dest: 'EST. LA GARENA (c.Colegios peatonal)',
            dep: 0,
            stops: ['06993@0', '06994@600', '06991@1200'],
          },
        ],
      } as CRTMLineDoc),
    );
    kv.set(CRTM_CONFIG.CACHE_KEYS.META, JSON.stringify(crtmMetaFixture()));
    const env = mockEnv(kv);

    const res = await app.request('/crtm/stops/arrivals/06994', {}, env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.realtime.available).toBe(true);
    const deps = body.data.departures as Record<string, unknown>[];
    expect(deps).toHaveLength(3);
    expect(deps[0]).toMatchObject({ line: '6', dir: 0, dest: 'VIRGEN DEL VAL' });
    expect(deps[1]).toMatchObject({
      line: '6',
      dir: 1,
      dest: 'EST. LA GARENA (c.Colegios peatonal)',
    });
    expect(deps[2]).toMatchObject({ line: '6', dir: 0, dest: 'EST. ALCALÁ D. JUAN CARLOS' });
  });

  it('resolución del modo de bus: GetStops 8_/9_, caché KV del mapeo y memo isolate', async () => {
    const fetchMock = widgetFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const { env, kv } = envWidget();

    await app.request('/crtm/stops/arrivals/09568', {}, env);

    // 2 GetStops (8_ existe + 9_ no existe) + 1 GetStopsTimes
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(kv.putCalls).toHaveLength(1);
    expect(kv.putCalls[0]).toMatchObject({
      key: `${CRTM_CONFIG.WIDGET.STOP_CODE_CACHE_PREFIX}09568`,
      options: { expirationTtl: CRTM_CONFIG.WIDGET.STOP_CODE_TTL },
    });
    expect(JSON.parse(kv.putCalls[0].value)).toEqual({ codStops: ['8_09568'] });

    // segunda petición en el mismo isolate: resolución memoizada y tablón cacheado → 0 fetches
    await app.request('/crtm/stops/arrivals/09568', {}, env);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(kv.putCalls).toHaveLength(1);
  });

  it('parada urbana (08712) resuelta como 9_ y ML (10_5) por identidad sin resolución', async () => {
    const fetchMock = widgetFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    const { env } = envWidget();

    const urban = await app.request('/crtm/stops/arrivals/08712', {}, env);
    const urbanBody = await jsonBody(urban);
    expect(urbanBody.data.count).toBe(1);
    expect(urbanBody.data.departures[0]).toMatchObject({
      line: '1',
      routeId: '9__1__013_',
      network: 'urban',
      dest: 'ESTACIÓN DE ALCORCÓN',
      arrivesInMin: 12,
    });

    const ml = await app.request('/crtm/stops/arrivals/10_5', {}, env);
    const mlBody = await jsonBody(ml);
    expect(mlBody.data.count).toBe(1);
    expect(mlBody.data.departures[0]).toMatchObject({
      line: 'ML2',
      routeId: '10__ML2___',
      network: 'ml',
      dest: 'COLONIA JARDIN',
      dir: 1,
      arrivesInMin: 20,
      time: '10:35',
    });

    // ML por identidad: ninguna llamada a GetStops.php (solo GetStopsTimes)
    const getStopCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes(CRTM_CONFIG.WIDGET.GET_STOP + '?'),
    );
    expect(getStopCalls).toHaveLength(2); // las 2 de la resolución de 08712
  });

  it('metro en modo catálogo (feed M4 stale): el board sirve llegadas del widget igualmente', async () => {
    vi.stubGlobal('fetch', widgetFetchMock());

    const res = await app.request('/crtm/stops/arrivals/4_263', {}, envMetroCatalog().env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(2);
    expect(body.data.realtime.available).toBe(true);
    expect(body.data.departures[0]).toMatchObject({
      line: '1',
      routeId: '4__1___',
      network: 'metro',
      dest: 'VALDECARROS',
      dir: 0,
      arrivesInMin: 3,
    });
    expect(body.data.noScheduleData).toBeUndefined();
  });

  it('?line= filtra y window recorta el tablón del widget', async () => {
    vi.stubGlobal('fetch', widgetFetchMock());
    const { env } = envWidget();

    const byLine = await app.request('/crtm/stops/arrivals/09568?line=211', {}, env);
    expect((await jsonBody(byLine)).data.count).toBe(1);

    const byLine421 = await app.request('/crtm/stops/arrivals/09568?line=421', {}, env);
    expect((await jsonBody(byLine421)).data.count).toBe(2);

    const short = await app.request('/crtm/stops/arrivals/09568?window=10', {}, env);
    expect((await jsonBody(short)).data.count).toBe(1); // solo la de +5 min

    const wide = await app.request('/crtm/stops/arrivals/09568?window=120', {}, env);
    expect((await jsonBody(wide)).data.count).toBe(4); // entra también la de +90 min
  });

  it('widget caído → tablón teórico del GTFS con realtime.available false (parada de bus)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

    const res = await app.request('/crtm/stops/arrivals/09568', {}, envWidget().env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.realtime.available).toBe(false);
    expect(body.message).toContain('tiempo real no disponible');
    expect(body.data.count).toBeGreaterThan(0);
    const deps = body.data.departures as Record<string, unknown>[];
    expect(deps.every((d) => d.realtime === false && d.scheduledISO === d.estimatedISO)).toBe(true);
    expect(deps[0]).toMatchObject({ line: '421', routeId: '8__421___', network: 'interurban' });
  });

  it('widget caído + estación de red en catálogo → sin teórico disponible: noScheduleData y aviso', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

    const res = await app.request('/crtm/stops/arrivals/4_263', {}, envMetroCatalog().env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.count).toBe(0);
    expect(body.data.realtime.available).toBe(false);
    expect(body.message).toContain('Sin horarios disponibles');
    expect(body.data.noScheduleData).toMatchObject({
      networks: ['metro'],
      calendarEnd: '20260527',
      feedVersions: ['v20250527'],
    });
  });

  it('board del widget VIVO pero vacío (SAE sin datos) → tablón teórico con available false', async () => {
    // Caso 09103/Torrelodones: el widget responde actualDate fresca + times {} (operador
    // sin estimaciones publicadas en el SAE) mientras el GTFS tiene salidas en ventana —
    // servir "no hay llegadas" sería mentir; se degrada a teórico como si estuviera caído
    const iso = (offsetSec: number) => new Date(CRTM_TEST_NOW + offsetSec * 1000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string | URL) => {
        const u = new URL(String(url));
        if (u.pathname.endsWith(CRTM_CONFIG.WIDGET.GET_STOP)) {
          return Promise.resolve(
            new Response(JSON.stringify({ stops: { Stop: { codStop: '8_09568' } } }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              stopTimes: {
                actualDate: iso(0),
                stop: { codStop: '8_09568', name: 'Pº Extremadura - Av. Portugal' },
                times: {},
                linesStatus: { LineStatus: [] },
              },
            }),
            { status: 200 },
          ),
        );
      }),
    );

    const res = await app.request('/crtm/stops/arrivals/09568', {}, envWidget().env);

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.realtime).toMatchObject({
      available: false,
      source: 'crtm-widget',
      feedTimestamp: new Date(CRTM_TEST_NOW).toISOString(),
    });
    expect(body.data.count).toBeGreaterThan(0);
    const deps = body.data.departures as Record<string, unknown>[];
    expect(deps.every((d) => d.realtime === false && d.scheduledISO === d.estimatedISO)).toBe(true);
    expect(deps[0]).toMatchObject({ line: '421', routeId: '8__421___', network: 'interurban' });
    expect(body.message).toContain('tiempo real no disponible');
  });

  it('widget vivo + board vacío + sin teórico en ventana → available true y "No hay llegadas"', async () => {
    // 08712 no tiene docs de línea en KV: el vacío queda como el widget lo cuenta
    // ("no hay vehículos ahora"), distinguishible del degradado por la causa real
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string | URL) => {
        const u = new URL(String(url));
        if (u.pathname.endsWith(CRTM_CONFIG.WIDGET.GET_STOP)) {
          const codStop = u.searchParams.get('codStop') ?? '';
          const body = codStop === '9_08712' ? { stops: { Stop: { codStop } } } : { stops: {} };
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      }),
    );

    const res = await app.request('/crtm/stops/arrivals/08712', {}, envWidget().env);

    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.count).toBe(0);
    expect(body.data.realtime.available).toBe(true);
    expect(body.message).toContain('No hay llegadas');
  });

  it('actualDate congelada >10 min → degradado a tablón teórico (anti-bandazos)', async () => {
    vi.stubGlobal('fetch', widgetFetchMock(CRTM_TEST_NOW, { frozen: true }));

    const res = await app.request('/crtm/stops/arrivals/09568', {}, envWidget().env);

    const body = await jsonBody(res);
    expect(body.data.realtime.available).toBe(false);
    expect(body.message).toContain('tiempo real no disponible');
  });

  it('validaciones: código inválido, parada inexistente y stopId EMT (fuera de /crtm)', async () => {
    vi.stubGlobal('fetch', widgetFetchMock());
    const { env } = envWidget();

    const invalid = await app.request('/crtm/stops/arrivals/bad--code', {}, env);
    expect(invalid.status).toBe(400);
    expect((await jsonBody(invalid)).message).toContain('stopCode inválido');

    const tooLong = await app.request('/crtm/stops/arrivals/abcdefghijklmnopq', {}, env);
    expect(tooLong.status).toBe(400);

    const unknown = await app.request('/crtm/stops/arrivals/99999', {}, env);
    expect(unknown.status).toBe(404);
    expect((await jsonBody(unknown)).message).toContain('No existe la parada CRTM');

    // 62 = parada EMT (no listada en stops:all CRTM): el bus urbano de Madrid va por /stops/arrivals
    const emt = await app.request('/crtm/stops/arrivals/62', {}, env);
    expect(emt.status).toBe(404);
  });
});

// ---------- /crtm/lines/incidents/:id (cercanías, feed del widget oficial del CRTM) ----------

function incidentsFetchMock(body: Record<string, unknown>) {
  return vi.fn().mockImplementation((url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith(CRTM_CONFIG.INCIDENTS.GET_INCIDENTS)) {
      expect(u.searchParams.get('mode')).toBe(CRTM_CONFIG.INCIDENTS.CERCANIAS_MODE);
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }
    return Promise.reject(new Error(`URL inesperada: ${u}`));
  });
}

describe('GET /crtm/lines/incidents/:id (cercanías)', () => {
  beforeEach(() => {
    __resetIncidentsInflight();
  });

  afterEach(() => {
    __resetIncidentsInflight();
    vi.unstubAllGlobals();
  });

  it('all: afectación C9 con routeId resuelto y paradas afectadas enlazadas por nombre', async () => {
    vi.stubGlobal('fetch', incidentsFetchMock(crtmCercaniasIncidentsFixture()));

    const res = await app.request('/crtm/lines/incidents/all', {}, envCercanias());

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=1800');
    const body = await jsonBody(res);
    expect(body.status).toBe('success');
    expect(body.data.count).toBe(1);
    expect(body.data.attribution).toContain('widget oficial del CRTM');

    const incident = body.data.incidents[0];
    expect(incident).toMatchObject({ label: 'C9', routeId: '10T_C9', type: 'AFF' });
    expect(incident.description).toContain('C-9');
    // CERCEDILLA/COTOS casan por igualdad normalizada; PUERTO NAVACERRADA por tokens
    expect(incident.affectedStops).toEqual([
      { name: 'CERCEDILLA', stopCode: 'r_18132' },
      { name: 'PUERTO NAVACERRADA', stopCode: 'r_18133' },
      { name: 'COTOS', stopCode: 'r_18134' },
    ]);
  });

  it('por label y por routeId exacto; línea de cercanías sin incidencias → 200 count 0', async () => {
    vi.stubGlobal('fetch', incidentsFetchMock(crtmCercaniasIncidentsFixture()));
    const env = envCercanias();

    const byLabel = await jsonBody(await app.request('/crtm/lines/incidents/C9', {}, env));
    expect(byLabel.data).toMatchObject({
      label: 'C9',
      routeId: '10T_C9',
      network: 'cercanias',
      count: 1,
    });
    expect(byLabel.message).toContain('1 incidencia(s) para la línea C9');

    const byRouteId = await jsonBody(await app.request('/crtm/lines/incidents/10T_C9', {}, env));
    expect(byRouteId.data.count).toBe(1);

    const c5 = await jsonBody(await app.request('/crtm/lines/incidents/C5', {}, env));
    expect(c5.data.count).toBe(0);
    expect(c5.message).toContain('Sin incidencias para la línea C5');
  });

  it('incidencia de una línea sin artefactos (C2c): listada en all con routeId null y sin paradas', async () => {
    vi.stubGlobal(
      'fetch',
      incidentsFetchMock(crtmCercaniasIncidentsFixture({ unknownLine: true })),
    );

    const res = await app.request('/crtm/lines/incidents/all', {}, envCercanias());

    const body = await jsonBody(res);
    expect(body.data.count).toBe(2);
    expect(body.data.incidents[1]).toMatchObject({
      label: 'C2c',
      routeId: null,
      affectedStops: [],
    });
  });

  it('línea de otra red → 200 con incidentsAvailable false (sin tocar el widget)', async () => {
    const fetchMock = incidentsFetchMock(crtmCercaniasIncidentsFixture());
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request('/crtm/lines/incidents/421', {}, envSchedule());

    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.data.incidentsAvailable).toBe(false);
    expect(body.data.count).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caché KV: el put lleva expirationTtl y la segunda petición no refetch-ea', async () => {
    const fetchMock = incidentsFetchMock(crtmCercaniasIncidentsFixture());
    vi.stubGlobal('fetch', fetchMock);
    const env = envCercanias();

    await app.request('/crtm/lines/incidents/C9', {}, env);
    await app.request('/crtm/lines/incidents/all', {}, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const putCalls = (
      env.EMT_CACHE as unknown as {
        putCalls: Array<{ key: string; options?: { expirationTtl?: number } }>;
      }
    ).putCalls;
    const put = putCalls.find((p) => p.key === CRTM_CONFIG.INCIDENTS.CACHE_KEY);
    expect(put?.options).toEqual({ expirationTtl: CRTM_CONFIG.INCIDENTS.TTL });
  });

  it('widget caído o con error → 503 con Retry-After', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));

    const res = await app.request('/crtm/lines/incidents/C9', {}, envCercanias());

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('300');
    expect((await jsonBody(res)).message).toContain('no disponibles');

    vi.stubGlobal(
      'fetch',
      incidentsFetchMock({ error: 'service_unavailable', message: 'Request Exception' }),
    );
    const errorBody = await app.request('/crtm/lines/incidents/all', {}, envCercanias());

    expect(errorBody.status).toBe(503);
  });

  it('feed sin avisos ({}) → 200 count 0 con mensaje distinguible', async () => {
    vi.stubGlobal('fetch', incidentsFetchMock(crtmCercaniasIncidentsFixture({ empty: true })));

    const all = await app.request('/crtm/lines/incidents/all', {}, envCercanias());
    const allBody = await jsonBody(all);
    expect(all.status).toBe(200);
    expect(allBody.data.count).toBe(0);
    expect(allBody.message).toContain('Sin incidencias en Cercanías');

    const c9 = await jsonBody(await app.request('/crtm/lines/incidents/C9', {}, envCercanias()));
    expect(c9.data.count).toBe(0);
  });

  it('404 línea inexistente y 400 id inválido (validados antes de tocar el widget)', async () => {
    const fetchMock = incidentsFetchMock(crtmCercaniasIncidentsFixture());
    vi.stubGlobal('fetch', fetchMock);
    const env = envCercanias();

    const notFound = await app.request('/crtm/lines/incidents/C7', {}, env);
    expect(notFound.status).toBe(404);
    expect((await jsonBody(notFound)).message).toContain('No existe la línea CRTM C7');

    const invalid = await app.request('/crtm/lines/incidents/C%21', {}, env);
    expect(invalid.status).toBe(400);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
