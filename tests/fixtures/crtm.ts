import type {
  CRTMStop,
  CRTMLinesAll,
  CRTMLineDoc,
  CRTMService,
  CRTMMeta,
  CRTMLineRouteDoc,
} from '../../src/types/crtm-data';
import { madridWallClock } from '../../src/lib/date-utils';
import { shiftDateKey } from '../../src/lib/crtm-schedule';

// 2026-08-20T08:15:00Z = jueves 20/08/2026 10:15 en Madrid (CEST): base determinista de los fixtures
export const CRTM_TEST_NOW = Date.parse('2026-08-20T08:15:00Z');

export function crtmStopsFixture(): CRTMStop[] {
  return [
    {
      code: '09568',
      name: 'Pº Extremadura - Av. Portugal',
      address: 'Av. de Portugal 12',
      lat: 40.4281,
      lon: -3.7405,
      zone: 'A',
      municipality: 'Madrid',
      lines: ['421'],
    },
    {
      code: '09999',
      name: 'Intercambiador de Moncloa',
      address: 'Calle de la Princesa 1',
      lat: 40.4295,
      lon: -3.7418,
      zone: 'A',
      municipality: 'Madrid',
      lines: ['421'],
    },
    {
      code: '08712',
      name: 'Av. Europa - C. Mayor',
      address: 'Calle Mayor 5',
      lat: 40.3452,
      lon: -3.8257,
      zone: 'B1',
      municipality: 'Alcorcón',
      lines: ['1'],
    },
    {
      code: '10_5',
      name: 'Somosaguas Sur - ML2',
      address: 'Avenida de Europa 2',
      lat: 40.4382,
      lon: -3.7879,
      zone: 'B1',
      municipality: 'Pozuelo de Alarcón',
      lines: ['ML2'],
    },
  ];
}

// El label '421' existe en las dos redes, hay un tercer doc ('9__999___') que no sirve la parada 09568
// y una línea de Metro Ligero (network ml) con color/textColor
export function crtmLinesAllFixture(): CRTMLinesAll {
  return {
    count: 5,
    lines: [
      {
        label: '421',
        routeId: '8__421___',
        name: 'Moncloa - Boadilla del Monte',
        network: 'interurban',
        municipality: 'Boadilla del Monte',
        url: 'https://www.crtm.es/8__421___.aspx',
      },
      {
        label: '421',
        routeId: '9__421___',
        name: 'Circular Alcorcón',
        network: 'urban',
        municipality: 'Alcorcón',
        url: null,
      },
      {
        label: '421',
        routeId: '9__999___',
        name: 'Leganés - Centro',
        network: 'urban',
        municipality: 'Leganés',
        url: null,
      },
      {
        label: '1',
        routeId: '9__1__013_',
        name: 'Urbano Alcorcón',
        network: 'urban',
        municipality: 'Alcorcón',
        url: null,
      },
      {
        label: 'ML2',
        routeId: '10__ML2___',
        name: 'Metro Ligero ML2 - Colonia Jardín - Aravaca',
        network: 'ml',
        municipality: 'Pozuelo de Alarcón',
        url: null,
        color: '00A0E9',
        textColor: 'FFFFFF',
      },
    ],
  };
}

/**
 * Docs de línea orientados a probar /crtm/stops/schedule/09568 con now fijo (CRTM_TEST_NOW):
 * - svc 0 (LAB, todos los días): +10, +50 y +180 min (fuera de ventana de 2h), +24:15 (madrugada ≥24:00
 *   del día de servicio de ayer → hoy a las +15 min) y dir 1 con offset +600 (salida a los +35 min)
 * - svc 1 (REFORZADO, hoy retirado con excepción 2): +40 min → excluido
 * - svc 2 (FESTIVO, solo existe por excepción 1 hoy): +55 min → incluido
 * - doc urbano 9__421___ con el mismo label: +45 min → incluido
 * - doc 9__999___ (label '421' que no para en 09568): no aporta salidas
 */
export function crtmScheduleDocsFixture(nowMs = CRTM_TEST_NOW): CRTMLineDoc[] {
  const wc = madridWallClock(nowMs);
  const secs = wc.secsOfDay;
  const today = wc.dateKey;
  const svcAllDays: CRTMService = {
    id: 'LAB',
    days: [1, 1, 1, 1, 1, 1, 1],
    from: shiftDateKey(today, -7),
    to: shiftDateKey(today, 7),
    exceptions: {},
  };
  const svcRemovedToday: CRTMService = {
    id: 'REFORZADO',
    days: [1, 1, 1, 1, 1, 1, 1],
    from: svcAllDays.from,
    to: svcAllDays.to,
    exceptions: { [today]: 2 },
  };
  const svcOnlyException: CRTMService = {
    id: 'FESTIVO',
    days: [0, 0, 0, 0, 0, 0, 0],
    from: null,
    to: null,
    exceptions: { [today]: 1 },
  };

  const interurban: CRTMLineDoc = {
    routeId: '8__421___',
    label: '421',
    name: 'Moncloa - Boadilla del Monte',
    network: 'interurban',
    municipality: 'Boadilla del Monte',
    url: 'https://www.crtm.es/8__421___.aspx',
    directions: [
      { id: 0, headsign: 'Madrid (Moncloa)', stops: ['09568', '09999'] },
      { id: 1, headsign: 'Boadilla del Monte', stops: ['09999', '09568'] },
    ],
    services: [svcAllDays, svcRemovedToday, svcOnlyException],
    trips: [
      {
        dir: 0,
        svc: 0,
        headsign: 'Madrid (Moncloa)',
        dep: secs + 600,
        stops: ['09568@0', '09999@900'],
      },
      {
        dir: 0,
        svc: 0,
        headsign: 'Madrid (Moncloa)',
        dep: secs + 3000,
        stops: ['09568@0', '09999@900'],
      },
      {
        dir: 0,
        svc: 0,
        headsign: 'Madrid (Moncloa)',
        dep: secs + 10800,
        stops: ['09568@0', '09999@900'],
      },
      {
        dir: 0,
        svc: 0,
        headsign: 'Madrid (Moncloa)',
        dep: 86400 + secs + 900,
        stops: ['09568@0', '09999@900'],
      },
      {
        dir: 1,
        svc: 0,
        headsign: 'Boadilla del Monte',
        dep: secs + 1500,
        stops: ['09999@0', '09568@600'],
      },
      {
        dir: 0,
        svc: 1,
        headsign: 'Madrid (Moncloa)',
        dep: secs + 2400,
        stops: ['09568@0', '09999@900'],
      },
      { dir: 0, svc: 2, headsign: '', dep: secs + 3300, stops: ['09568@0', '09999@900'] },
    ],
  };

  const urban: CRTMLineDoc = {
    routeId: '9__421___',
    label: '421',
    name: 'Circular Alcorcón',
    network: 'urban',
    municipality: 'Alcorcón',
    url: null,
    directions: [{ id: 0, headsign: 'Estación de Alcorcón', stops: ['09568'] }],
    services: [{ ...svcAllDays, id: 'LAB-U' }],
    trips: [
      { dir: 0, svc: 0, headsign: 'Estación de Alcorcón', dep: secs + 2700, stops: ['09568@0'] },
    ],
  };

  const notServingStop: CRTMLineDoc = {
    routeId: '9__999___',
    label: '421',
    name: 'Leganés - Centro',
    network: 'urban',
    municipality: 'Leganés',
    url: null,
    directions: [{ id: 0, headsign: 'Leganés', stops: ['08712'] }],
    services: [{ ...svcAllDays, id: 'LAB-L' }],
    trips: [{ dir: 0, svc: 0, headsign: 'Leganés', dep: secs + 2700, stops: ['08712@0'] }],
  };

  // Metro Ligero (network ml, código de parada namespacelado 10_5): +20 min → 10:35
  const ml: CRTMLineDoc = {
    routeId: '10__ML2___',
    label: 'ML2',
    name: 'Metro Ligero ML2 - Colonia Jardín - Aravaca',
    network: 'ml',
    municipality: 'Pozuelo de Alarcón',
    url: null,
    color: '00A0E9',
    textColor: 'FFFFFF',
    directions: [{ id: 0, headsign: 'Colonia Jardín', stops: ['10_5'] }],
    services: [{ ...svcAllDays, id: 'ML-TODOS' }],
    trips: [{ dir: 0, svc: 0, headsign: 'Colonia Jardín', dep: secs + 1200, stops: ['10_5@0'] }],
  };

  return [interurban, urban, notServingStop, ml];
}

/**
 * Doc estático para /crtm/lines/timetable: dos direcciones con dos patrones de servicio
 * (laborables y finde) y una salida a las 24:15 (madrugada GTFS)
 */
export function crtmTimetableDocFixture(): CRTMLineDoc {
  return {
    routeId: '8__421___',
    label: '421',
    name: 'Moncloa - Boadilla del Monte',
    network: 'interurban',
    municipality: 'Boadilla del Monte',
    url: null,
    directions: [
      { id: 0, headsign: 'Madrid (Moncloa)', stops: ['09568', '09999'] },
      { id: 1, headsign: 'Boadilla del Monte', stops: ['09999', '09568'] },
    ],
    services: [
      { id: 'LAB', days: [1, 1, 1, 1, 1, 0, 0], from: '20260701', to: '20260831', exceptions: {} },
      { id: 'FIN', days: [0, 0, 0, 0, 0, 1, 1], from: '20260701', to: '20260831', exceptions: {} },
    ],
    trips: [
      { dir: 0, svc: 0, headsign: 'Madrid (Moncloa)', dep: 6 * 3600, stops: ['09568@0'] },
      { dir: 0, svc: 0, headsign: 'Madrid (Moncloa)', dep: 6.5 * 3600, stops: ['09568@0'] },
      { dir: 0, svc: 0, headsign: 'Madrid (Moncloa)', dep: 22 * 3600, stops: ['09568@0'] },
      { dir: 0, svc: 1, headsign: 'Madrid (Moncloa)', dep: 8 * 3600, stops: ['09568@0'] },
      { dir: 0, svc: 1, headsign: 'Madrid (Moncloa)', dep: 9.5 * 3600, stops: ['09568@0'] },
      { dir: 1, svc: 0, headsign: 'Boadilla del Monte', dep: 7 * 3600, stops: ['09568@600'] },
      { dir: 1, svc: 0, headsign: 'Boadilla del Monte', dep: 23.5 * 3600, stops: ['09568@600'] },
      {
        dir: 1,
        svc: 1,
        headsign: 'Boadilla del Monte',
        dep: 24 * 3600 + 15 * 60,
        stops: ['09568@600'],
      },
    ],
  };
}

/**
 * Doc de línea Metro (network metro, M4) con trips plantilla de frequencies.txt:
 * - dir 0 (Valdecarros): bandas 10:00–11:00 cada 10 min y 11:00–12:30 cada 8 min, offset +300 s a 4_250
 *   (intermedia del dir 0: 4_261 es la terminal, para que 4_250 aporte salidas y no llegadas)
 * - dir 1 (Pinar de Chamartín): trip explícito 23:45 + banda 24:10–24:40 cada 15 min (madrugada ≥24:00)
 * Base temporal: CRTM_TEST_NOW (jueves 20/08/2026 10:15 Madrid)
 */
export function crtmMetroFreqDocFixture(nowMs: number = CRTM_TEST_NOW): CRTMLineDoc {
  const wc = madridWallClock(nowMs);
  const today = wc.dateKey;
  const svcAllDays: CRTMService = {
    id: 'METRO-TODOS',
    days: [1, 1, 1, 1, 1, 1, 1],
    from: shiftDateKey(today, -7),
    to: shiftDateKey(today, 7),
    exceptions: {},
  };

  return {
    routeId: '4__1_____',
    label: '1',
    name: 'Metro L1 Pinar de Chamartín - Valdecarros',
    network: 'metro',
    municipality: 'Madrid',
    url: null,
    color: '58ABE8',
    textColor: 'FFFFFF',
    directions: [
      { id: 0, headsign: 'Valdecarros', stops: ['4_263', '4_250', '4_261'] },
      { id: 1, headsign: 'Pinar de Chamartín', stops: ['4_250', '4_263'] },
    ],
    services: [svcAllDays],
    trips: [
      {
        dir: 0,
        svc: 0,
        headsign: 'Valdecarros',
        freq: [
          { from: 10 * 3600, to: 11 * 3600, headway: 600 },
          { from: 11 * 3600, to: 12 * 3600 + 30 * 60, headway: 480 },
        ],
        stops: ['4_263@0', '4_250@300', '4_261@600'],
      },
      {
        dir: 1,
        svc: 0,
        headsign: 'Pinar de Chamartín',
        dep: 23 * 3600 + 45 * 60,
        stops: ['4_250@0', '4_263@300'],
      },
      {
        dir: 1,
        svc: 0,
        headsign: 'Pinar de Chamartín',
        freq: [{ from: 24 * 3600 + 10 * 60, to: 24 * 3600 + 40 * 60, headway: 900 }],
        stops: ['4_250@0', '4_263@300'],
      },
    ],
  };
}

/**
 * Cercanías Renfe (network cercanias, GTFS NAP núcleo 10T): set aislado para probar el
 * lado lectura con la forma real de los artefactos del pipeline — códigos r_<stop_id>,
 * services de un solo día (ventana móvil de Renfe) y dest por trip = última estación.
 * Base temporal: CRTM_TEST_NOW (jueves 20/08/2026 10:15 Madrid).
 */
export function crtmCercaniasStopsFixture(): CRTMStop[] {
  return [
    {
      code: 'r_18000',
      name: 'Madrid-Atocha Cercanías',
      address: null,
      lat: 40.4055,
      lon: -3.6886,
      zone: null,
      municipality: 'Madrid',
      lines: ['C5'],
    },
    {
      code: 'r_17100',
      name: 'Doce de Octubre',
      address: null,
      lat: 40.3892,
      lon: -3.7005,
      zone: null,
      municipality: 'Madrid',
      lines: ['C5'],
    },
    {
      code: 'r_18123',
      name: 'Humanes',
      address: null,
      lat: 40.2727,
      lon: -3.6374,
      zone: null,
      municipality: 'Humanes de Madrid',
      lines: ['C5'],
    },
    {
      code: 'r_18125',
      name: 'Móstoles-El Soto',
      address: null,
      lat: 40.3159,
      lon: -3.8787,
      zone: null,
      municipality: 'Móstoles',
      lines: ['C5'],
    },
    // corredor C9 (incidencias del widget): Cercedilla casa por igualdad normalizada y
    // Puerto de Navacerrada por tokens (el widget la llama "PUERTO NAVACERRADA")
    {
      code: 'r_18132',
      name: 'Cercedilla',
      address: null,
      lat: 40.7396,
      lon: -4.0649,
      zone: null,
      municipality: 'Cercedilla',
      lines: ['C9'],
    },
    {
      code: 'r_18133',
      name: 'Puerto de Navacerrada',
      address: null,
      lat: 40.7986,
      lon: -3.9603,
      zone: null,
      municipality: 'Navacerrada',
      lines: ['C9'],
    },
    {
      code: 'r_18134',
      name: 'Cotos',
      address: null,
      lat: 40.8339,
      lon: -3.9552,
      zone: null,
      municipality: 'Rascafría',
      lines: ['C9'],
    },
  ];
}

export function crtmCercaniasLinesAllFixture(): CRTMLinesAll {
  return {
    count: 2,
    lines: [
      {
        label: 'C5',
        routeId: '10T_C5',
        name: 'Mostoles el Soto - Humanes',
        network: 'cercanias',
        municipality: 'Móstoles',
        url: null,
        color: 'FECB00',
        textColor: '000000',
      },
      {
        label: 'C9',
        routeId: '10T_C9',
        name: 'Cercedilla - Cotos',
        network: 'cercanias',
        municipality: 'Cercedilla',
        url: null,
      },
    ],
  };
}

export function crtmCercaniasDocsFixture(nowMs: number = CRTM_TEST_NOW): CRTMLineDoc[] {
  const wc = madridWallClock(nowMs);
  const secs = wc.secsOfDay;
  const today = wc.dateKey;
  // patrón Renfe: un service_id por fecha (jueves 20/08 y viernes 21/08 de la ventana móvil)
  const svcJueves: CRTMService = {
    id: 'C5-J-0820',
    days: [0, 0, 0, 1, 0, 0, 0],
    from: today,
    to: today,
    exceptions: {},
  };
  const svcViernes: CRTMService = {
    id: 'C5-V-0821',
    days: [0, 0, 0, 0, 1, 0, 0],
    from: shiftDateKey(today, 1),
    to: shiftDateKey(today, 1),
    exceptions: {},
  };

  return [
    {
      routeId: '10T_C5',
      label: 'C5',
      name: 'Mostoles el Soto - Humanes',
      network: 'cercanias',
      municipality: 'Móstoles',
      url: null,
      color: 'FECB00',
      textColor: '000000',
      directions: [
        {
          id: 0,
          headsign: 'Mostoles el Soto - Humanes',
          stops: ['r_18123', 'r_18000', 'r_17100', 'r_18125'],
        },
        {
          id: 1,
          headsign: 'Mostoles el Soto - Humanes',
          stops: ['r_18125', 'r_17100', 'r_18000', 'r_18123'],
        },
      ],
      services: [svcJueves, svcViernes],
      trips: [
        // tid = trip_id GTFS original: mismo identificador que el GTFS-RT de Renfe (1041L<trenId>C5)
        {
          dir: 0,
          svc: 0,
          headsign: '',
          dest: 'Móstoles-El Soto',
          dep: secs + 420,
          tid: '1041L19791C5',
          stops: ['r_18000@0', 'r_17100@480', 'r_18125@1380'],
        },
        {
          dir: 0,
          svc: 0,
          headsign: '',
          dest: 'Humanes',
          dep: secs + 1320,
          tid: '1041L19792C5',
          stops: ['r_17100@0', 'r_18000@540', 'r_18123@1500'],
        },
        {
          dir: 0,
          svc: 0,
          headsign: '',
          dest: 'Móstoles-El Soto',
          dep: secs + 2400,
          tid: '1041L19795C5',
          stops: ['r_18000@0', 'r_17100@480', 'r_18125@1380'],
        },
        {
          dir: 1,
          svc: 1,
          headsign: '',
          dest: 'Humanes',
          dep: 25 * 3600 + 900,
          tid: '1041L19793C5',
          stops: ['r_18000@0', 'r_18123@1800'],
        },
      ],
    },
  ];
}

/**
 * Cuerpos crudos del GTFS-RT de Renfe (trip_updates.json / vehicle_positions.json) para
 * mockear fetch en los tests de /crtm/stops/arrivals. Base: now fijo (CRTM_TEST_NOW).
 * Entidades (todas nacionales, el filtro de Madrid las recorta):
 * - 1041L19791C5 SCHEDULED: delay global 120 pero su próxima parada ES 18000 con
 *   arrival.time exacto (10:26) → el board usa la estimación exacta (delaySec derivado 240)
 * - 1041L19792C5 SCHEDULED: delay global 60, próxima parada 17100 (no la consultada)
 *   → estimated = programada + 60
 * - 1041L19795C5 CANCELED: el tren de las 10:55 sale cancelado (flag, no exclusión)
 * - SPECIAL_10_99001C5 ADDED parando en 18000 (10:23): refuerzo fuera del GTFS estático
 * - SPECIAL_10_99002C3 ADDED parando en 18000 (10:30): refuerzo de otra línea (routeId null)
 * - 1041L19789C5: tren real de Madrid cuya próxima parada NO es 18000 (no se inyecta)
 * - 3041L23574C1: Sevilla → filtrado por prefijo de núcleo
 * VP: andén dentro de label (incluido el raro PLATF.(0)), posición y status
 */
export function crtmRenfeRealtimeFixture(
  nowMs: number = CRTM_TEST_NOW,
  opts: { stale?: boolean } = {},
) {
  const sec = (offsetSec: number) => Math.floor(nowMs / 1000) + offsetSec;
  const feedTs = sec(opts.stale ? -10 * 60 : 0);

  const tripUpdates = {
    header: { gtfsRealtimeVersion: '2.0', timestamp: String(feedTs) },
    entity: [
      {
        id: 'TUUPDATE_1041L19791C5',
        tripUpdate: {
          trip: { tripId: '1041L19791C5', scheduleRelationship: 'SCHEDULED' },
          stopTimeUpdate: [{ stopId: '18000', arrival: { delay: 240, time: String(sec(660)) } }],
          vehicle: { wheelchairAccessible: 'WHEELCHAIR_ACCESSIBLE' },
          delay: 120,
        },
      },
      {
        id: 'TUUPDATE_1041L19792C5',
        tripUpdate: {
          trip: { tripId: '1041L19792C5', scheduleRelationship: 'SCHEDULED' },
          stopTimeUpdate: [{ stopId: '17100', arrival: { delay: 60, time: String(sec(1860)) } }],
          vehicle: { wheelchairAccessible: 'WHEELCHAIR_INACCESSIBLE' },
          delay: 60,
        },
      },
      {
        id: 'TUUPDATE_1041L19795C5',
        tripUpdate: {
          trip: { tripId: '1041L19795C5', scheduleRelationship: 'CANCELED' },
          stopTimeUpdate: [{ stopId: '18000', arrival: { delay: 0, time: String(sec(2400)) } }],
          vehicle: { wheelchairAccessible: 'UNKNOWN' },
        },
      },
      {
        id: 'TUUPDATE_SPECIAL_10_99001C5',
        tripUpdate: {
          trip: { tripId: 'SPECIAL_10_99001C5', scheduleRelationship: 'ADDED' },
          stopTimeUpdate: [{ stopId: '18000', arrival: { delay: 0, time: String(sec(480)) } }],
          vehicle: { wheelchairAccessible: 'WHEELCHAIR_ACCESSIBLE' },
        },
      },
      {
        id: 'TUUPDATE_SPECIAL_10_99002C3',
        tripUpdate: {
          trip: { tripId: 'SPECIAL_10_99002C3', scheduleRelationship: 'ADDED' },
          stopTimeUpdate: [{ stopId: '18000', arrival: { delay: 0, time: String(sec(900)) } }],
          vehicle: { wheelchairAccessible: 'WHEELCHAIR_ACCESSIBLE' },
        },
      },
      {
        id: 'TUUPDATE_1041L19789C5',
        tripUpdate: {
          trip: { tripId: '1041L19789C5', scheduleRelationship: 'SCHEDULED' },
          stopTimeUpdate: [{ stopId: '18125', arrival: { delay: 0, time: String(sec(300)) } }],
          delay: 0,
        },
      },
      {
        id: 'TUUPDATE_3041L23574C1',
        tripUpdate: {
          trip: { tripId: '3041L23574C1', scheduleRelationship: 'SCHEDULED' },
          stopTimeUpdate: [{ stopId: '50703', arrival: { delay: 1140, time: String(sec(60)) } }],
          vehicle: { wheelchairAccessible: 'WHEELCHAIR_INACCESSIBLE' },
          delay: 1140,
        },
      },
    ],
  };

  const vehiclePositions = {
    header: { gtfsRealtimeVersion: '2.0', timestamp: String(feedTs) },
    entity: [
      {
        vehicle: {
          trip: { tripId: '1041L19791C5' },
          position: { latitude: 40.4008, longitude: -3.6826 },
          currentStatus: 'INCOMING_AT',
          timestamp: String(feedTs),
          stopId: '18000',
          vehicle: { id: '19791', label: 'C5-19791-PLATF.(9)' },
        },
      },
      {
        vehicle: {
          trip: { tripId: '1041L19795C5' },
          position: { latitude: 40.3892, longitude: -3.7005 },
          currentStatus: 'STOPPED_AT',
          timestamp: String(feedTs),
          stopId: '17100',
          vehicle: { id: '19795', label: 'C5-19795-PLATF.(10)' },
        },
      },
      {
        vehicle: {
          trip: { tripId: 'SPECIAL_10_99001C5' },
          position: { latitude: 40.402, longitude: -3.683 },
          currentStatus: 'EN_ROUTE',
          timestamp: String(feedTs),
          stopId: '17100',
          vehicle: { id: '99001', label: 'C5-99001-PLATF.(2)' },
        },
      },
      {
        vehicle: {
          trip: { tripId: 'SPECIAL_10_99002C3' },
          position: { latitude: 40.403, longitude: -3.684 },
          currentStatus: 'STOPPED_AT',
          timestamp: String(feedTs),
          stopId: '17100',
          vehicle: { id: '99002', label: 'C3-99002-PLATF.(0)' },
        },
      },
      {
        vehicle: {
          trip: { tripId: '3041L23574C1' },
          position: { latitude: 37.39, longitude: -5.98 },
          currentStatus: 'IN_TRANSIT_TO',
          timestamp: String(feedTs),
          stopId: '50703',
          vehicle: { id: '23574', label: 'C1-23574-PLATF.(3)' },
        },
      },
    ],
  };

  return { tripUpdates, vehiclePositions };
}

// ---------- Widget oficial del CRTM (tiempo real de bus/ML/metro) ----------

/**
 * Cuerpos crudos del widget (GetStopsTimes.php, con los quirks reales verificados en vivo
 * 2026-10-09) para mockear fetch en los tests de /crtm/stops/arrivals de bus/ML/metro.
 * Base: now fijo (CRTM_TEST_NOW). Claves = codStop del widget.
 * - 8_09568 (interurbana): 421 dir 1 → +5 min (SAE true), 211 dir 1 → +12 min (SAE false,
 *   hora teórica), 421 dir 2 → +35 min con vehículo, 421 a +90 min (fuera de window 60)
 *   y 421 a -60 s (ya efectiva: filtrada)
 * - 9_08712 (urbana): línea 1 → +12 min con times.Time como OBJETO suelto (colección de 1)
 * - 10_5 (ML): ML2 → +20 min, también Time objeto suelto y linesStatus objeto suelto
 * - 4_263 (metro): L1 en ambos sentidos (+3 dir 1, +10 dir 2)
 */
export function crtmWidgetStopTimesFixture(
  nowMs: number = CRTM_TEST_NOW,
  opts: { frozen?: boolean } = {},
): Record<string, unknown> {
  const iso = (offsetSec: number) => new Date(nowMs + offsetSec * 1000).toISOString();
  const actualDate = iso(opts.frozen ? -11 * 60 : 0);
  const line421 = {
    codLine: '8__421___',
    shortDescription: '421',
    description: '421-MADRID (Moncloa)-BOADILLA DEL MONTE',
    codMode: '8',
  };
  const line211 = {
    codLine: '8__211___',
    shortDescription: '211',
    description: '211-MADRID (Moncloa)-BOADILLA DEL MONTE',
    codMode: '8',
  };

  return {
    '8_09568': {
      stopTimes: {
        actualDate,
        stop: { codStop: '8_09568', shortCodStop: '09568', name: 'Pº EXTREMADURA - AV. PORTUGAL' },
        times: {
          Time: [
            {
              line: line421,
              direction: 1,
              destination: 'MADRID (Moncloa)-BOADILLA DEL MONTE',
              destinationStop: { codStop: '8_09999', name: 'INTERCAMBIADOR DE MONCLOA' },
              time: iso(300),
              codVehicle: '',
              codIssue: '',
            },
            {
              line: line211,
              direction: 1,
              destination: 'MADRID (Moncloa)-BOADILLA DEL MONTE',
              destinationStop: { codStop: '8_09999', name: 'INTERCAMBIADOR DE MONCLOA' },
              time: iso(720),
              codVehicle: '',
              codIssue: '',
            },
            {
              line: line421,
              direction: 2,
              destination: 'BOADILLA DEL MONTE-MADRID (Moncloa)',
              destinationStop: { codStop: '8_08412', name: 'BOADILLA DEL MONTE' },
              time: iso(2100),
              codVehicle: 'E-1234',
              codIssue: '8__421___',
            },
            {
              line: line421,
              direction: 1,
              destination: 'MADRID (Moncloa)-BOADILLA DEL MONTE',
              destinationStop: { codStop: '8_09999', name: 'INTERCAMBIADOR DE MONCLOA' },
              time: iso(5400),
              codVehicle: '',
              codIssue: '',
            },
            {
              line: line421,
              direction: 1,
              destination: 'MADRID (Moncloa)-BOADILLA DEL MONTE',
              destinationStop: { codStop: '8_09999', name: 'INTERCAMBIADOR DE MONCLOA' },
              time: iso(-60),
              codVehicle: '',
              codIssue: '',
            },
          ],
        },
        linesStatus: {
          LineStatus: [
            { line: { codLine: '8__421___', shortDescription: '421' }, SAEStatus: true },
            { line: { codLine: '8__211___', shortDescription: '211' }, SAEStatus: false },
          ],
        },
      },
    },
    '9_08712': {
      stopTimes: {
        actualDate,
        stop: { codStop: '9_08712', shortCodStop: '08712', name: 'AV. EUROPA - C. MAYOR' },
        times: {
          Time: {
            line: {
              codLine: '9__1__013_',
              shortDescription: '1',
              description: '1-Hospital de Alcorcón',
              codMode: '9',
            },
            direction: 1,
            destination: 'ALCORCÓN',
            destinationStop: { codStop: '9_08700', name: 'ESTACIÓN DE ALCORCÓN' },
            time: iso(720),
            codVehicle: '',
            codIssue: '',
          },
        },
        linesStatus: {
          LineStatus: { line: { codLine: '9__1__013_', shortDescription: '1' }, SAEStatus: true },
        },
      },
    },
    '10_5': {
      stopTimes: {
        actualDate,
        stop: { codStop: '10_5', shortCodStop: '5', name: 'SOMOSAGUAS SUR - ML2' },
        times: {
          Time: {
            line: {
              codLine: '10__ML2___',
              shortDescription: 'ML2',
              description: 'ML2-Colonia Jardín-Aravaca',
              codMode: '10',
            },
            direction: 2,
            destination: 'ARAVACA-COLONIA JARDÍN',
            destinationStop: { codStop: '10_19', name: 'COLONIA JARDIN' },
            time: iso(1200),
            codVehicle: '',
            codIssue: '',
          },
        },
        linesStatus: {
          LineStatus: { line: { codLine: '10__ML2___', shortDescription: 'ML2' }, SAEStatus: true },
        },
      },
    },
    '4_263': {
      stopTimes: {
        actualDate,
        stop: { codStop: '4_263', shortCodStop: '263', name: 'PINAR DE CHAMARTIN' },
        times: {
          Time: [
            {
              line: {
                codLine: '4__1___',
                shortDescription: '1',
                description: '1-Pinar de Chamartín-Valdecarros',
                codMode: '4',
              },
              direction: 1,
              destination: 'VALDECARROS',
              destinationStop: { codStop: '4_295', name: 'VALDECARROS' },
              time: iso(180),
              codVehicle: '',
              codIssue: '',
            },
            {
              line: {
                codLine: '4__1___',
                shortDescription: '1',
                description: '1-Pinar de Chamartín-Valdecarros',
                codMode: '4',
              },
              direction: 2,
              destination: 'PINAR DE CHAMARTIN',
              destinationStop: { codStop: '4_263', name: 'PINAR DE CHAMARTIN' },
              time: iso(600),
              codVehicle: '',
              codIssue: '',
            },
          ],
        },
        linesStatus: {
          LineStatus: { line: { codLine: '4__1___', shortDescription: '1' }, SAEStatus: true },
        },
      },
    },
  };
}

/**
 * Cuerpos de GetStops.php para mockear la resolución del modo de bus: la 09568 existe
 * como 8_ y la 08712 como 9_ (el modo del poste no se deriva de la red de sus líneas)
 */
export function crtmWidgetGetStopsFixture(): Record<string, unknown> {
  return {
    '8_09568': {
      stops: {
        Stop: {
          codStop: '8_09568',
          shortCodStop: '09568',
          codMode: '8',
          name: 'Pº EXTREMADURA - AV. PORTUGAL',
          codLines: { Line: '8__421___' },
        },
      },
    },
    '9_09568': { stops: {} },
    '9_08712': {
      stops: {
        Stop: {
          codStop: '9_08712',
          shortCodStop: '08712',
          codMode: '9',
          name: 'AV. EUROPA - C. MAYOR',
          codLines: { Line: '9__1__013_' },
        },
      },
    },
    '8_08712': { stops: {} },
  };
}

// ---------- Incidencias de cercanías (GetIncidentsAffectations.php?mode=5 del widget) ----------

/**
 * Cuerpo crudo del feed de incidencias del widget (verificado en vivo 2026-10-11: la
 * afectación REAL de las obras C9, colección de 1 = objeto suelto). Opciones:
 * - empty: feed sin avisos ({"incidentsAffectations":{}})
 * - unknownLine: añade una afectación de una línea declarada sin servicio en el feed
 *   (C2c, array de 2) para probar el parseo de listas y routeId sin resolver
 */
export function crtmCercaniasIncidentsFixture(
  opts: { empty?: boolean; unknownLine?: boolean } = {},
): Record<string, unknown> {
  if (opts.empty) return { incidentsAffectations: {} };
  const c9 = {
    codMode: '5',
    codLine: '5__C9___',
    type: 'AFF',
    description:
      'Desde el 6 de mayo hasta fin de obras, se realizarán las obras de renovación integral de la línea C-9, el servicio quedará interrumpido durante la duración de las obras Cercedilla-Puerto de Navacerrada -Los Cotos. Se realiza servicio sustitutivo por carretera.',
    stopsAffectated: {
      ShortStop: [
        { codStop: '5_16', shortCodStop: '16', name: 'CERCEDILLA', park: 0, nightLinesService: 0 },
        {
          codStop: '5_63',
          shortCodStop: '63',
          name: 'PUERTO NAVACERRADA',
          park: 0,
          nightLinesService: 0,
        },
        { codStop: '5_23', shortCodStop: '23', name: 'COTOS', park: 0, nightLinesService: 0 },
      ],
    },
  };
  const c2c = {
    codMode: '5',
    codLine: '5__C2c__',
    type: 'AFF',
    description: 'Afectación de una línea declarada sin servicio en el feed.',
    stopsAffectated: {},
  };
  return { incidentsAffectations: { IncidentAffectation: opts.unknownLine ? [c9, c2c] : c9 } };
}

export function crtmMetaFixture(): CRTMMeta {
  return {
    versions: {
      interurban: { itemModified: 1755560000000, zipBytes: 72345678, feedVersions: ['2026.7.26'] },
      urban: { itemModified: 1755560000000, zipBytes: 8123456, feedVersions: ['2026.7.22'] },
      ml: { itemModified: 1755560000000, zipBytes: 400123, feedVersions: ['2026.7.22'] },
      cercanias: {
        itemModified: '2026-08-25T05:21:21Z',
        zipBytes: 16478682,
        feedVersions: ['20260825'],
      },
    },
    generatedAt: '2026-08-19T05:41:00.000Z',
    counts: {
      stopsKept: 8055,
      muniCoverage: 0.987,
      trips: 64100,
      lineDocs: { interurban: 351, urban: 100, ml: 4 },
    },
    shapes: {
      bucket: 'madmovil-crtm-shapes',
      count: 440,
      totalBytes: 2_400_000,
      maxBytes: 120_000,
      maxRouteId: '8__591___',
    },
  };
}

// Doc de R2 line/8__421___.json para /crtm/lines/route/:routeId
export function crtmRouteDocFixture(): CRTMLineRouteDoc {
  return {
    routeId: '8__421___',
    label: '421',
    name: 'Moncloa - Boadilla del Monte',
    network: 'interurban',
    municipality: 'Boadilla del Monte',
    toleranceM: 1.5,
    bounds: [-3.7418, 40.4281, -3.8257, 40.4295],
    directions: [
      {
        id: 0,
        headsign: 'Madrid (Moncloa)',
        shapeId: 'S-421-A',
        distanceM: 24_800,
        pointCount: 320,
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [-3.8257, 40.4295],
              [-3.75, 40.429],
              [-3.7418, 40.4281],
            ],
          ],
        },
      },
      {
        id: 1,
        headsign: 'Boadilla del Monte',
        shapeId: 'S-421-B',
        distanceM: 25_100,
        pointCount: 335,
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [-3.7418, 40.4281],
              [-3.78, 40.4288],
            ],
            [
              [-3.9, 40.4294],
              [-3.8257, 40.4295],
            ],
          ],
        },
      },
    ],
  };
}
