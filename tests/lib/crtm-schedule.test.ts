import { describe, expect, it } from 'vitest';
import {
  serviceRunsOn,
  computeStopDepartures,
  computeStopDayDepartures,
  buildLineTimetable,
  shiftDateKey,
  dayIndexOf,
  formatHM,
  freqBandInstances,
  resolveDirectionDestinations,
  modeDestByDirection,
  widgetDestinations,
  resolveWidgetDest,
} from '../../src/lib/crtm-schedule';
import { madridInstantFromWall } from '../../src/lib/date-utils';
import {
  CRTM_TEST_NOW,
  crtmScheduleDocsFixture,
  crtmTimetableDocFixture,
  crtmMetroFreqDocFixture,
} from '../fixtures/crtm';
import type { CRTMLineDoc, CRTMService, CRTMTrip } from '../../src/types/crtm-data';

const LAB: CRTMService = {
  id: 'LAB',
  days: [1, 1, 1, 1, 1, 0, 0],
  from: '20260701',
  to: '20260831',
  exceptions: {},
};

describe('serviceRunsOn', () => {
  it('circula si está en rango y el día de la semana coincide', () => {
    expect(serviceRunsOn(LAB, '20260820', dayIndexOf('20260820'))).toBe(true); // jueves
  });

  it('no circula fuera del día de la semana (sábado con patrón laborables)', () => {
    expect(serviceRunsOn(LAB, '20260822', dayIndexOf('20260822'))).toBe(false);
  });

  it('no circula fuera del rango from/to', () => {
    expect(serviceRunsOn(LAB, '20260901', dayIndexOf('20260901'))).toBe(false);
    expect(serviceRunsOn(LAB, '20260630', dayIndexOf('20260630'))).toBe(false);
  });

  it('excepción 1 añade y excepción 2 retira con prioridad sobre calendar', () => {
    const added: CRTMService = { ...LAB, exceptions: { 20260822: 1 } };
    const removed: CRTMService = { ...LAB, exceptions: { 20260820: 2 } };
    expect(serviceRunsOn(added, '20260822', dayIndexOf('20260822'))).toBe(true);
    expect(serviceRunsOn(removed, '20260820', dayIndexOf('20260820'))).toBe(false);
  });

  it('servicio sin fila en calendar.txt (from null) solo existe por excepción', () => {
    const onlyExceptions: CRTMService = {
      id: 'X',
      days: [1, 1, 1, 1, 1, 1, 1],
      from: null,
      to: null,
      exceptions: { 20260820: 1 },
    };
    expect(serviceRunsOn(onlyExceptions, '20260820', dayIndexOf('20260820'))).toBe(true);
    expect(serviceRunsOn(onlyExceptions, '20260821', dayIndexOf('20260821'))).toBe(false);
  });
});

describe('helpers de fechas GTFS', () => {
  it('shiftDateKey cruza fin de mes', () => {
    expect(shiftDateKey('20260831', 1)).toBe('20260901');
    expect(shiftDateKey('20260901', -1)).toBe('20260831');
    expect(shiftDateKey('20260301', -1)).toBe('20260228'); // 2026 no es bisiesto
  });

  it('dayIndexOf: 0 = lunes, 6 = domingo', () => {
    expect(dayIndexOf('20260817')).toBe(0);
    expect(dayIndexOf('20260820')).toBe(3);
    expect(dayIndexOf('20260823')).toBe(6);
  });

  it('formatHM conserva horas ≥24 en convención GTFS', () => {
    expect(formatHM(0)).toBe('00:00');
    expect(formatHM(22 * 3600 + 15 * 60)).toBe('22:15');
    expect(formatHM(24 * 3600 + 15 * 60)).toBe('24:15');
  });
});

describe('buildLineTimetable', () => {
  it('agrega primero/último/expediciones por dirección y por patrón de servicio', () => {
    const directions = buildLineTimetable(crtmTimetableDocFixture());

    expect(directions).toHaveLength(2);
    const dir0 = directions[0];
    expect(dir0.headsign).toBe('Madrid (Moncloa)');
    expect(dir0.first).toBe('06:00');
    expect(dir0.last).toBe('22:00');
    expect(dir0.trips).toBe(5);
    expect(dir0.services.map((s) => s.id)).toEqual(['LAB', 'FIN']);
    expect(dir0.services[0]).toMatchObject({ first: '06:00', last: '22:00', trips: 3 });
    expect(dir0.services[1]).toMatchObject({ first: '08:00', last: '09:30', trips: 2 });

    const dir1 = directions[1];
    expect(dir1.first).toBe('07:00');
    expect(dir1.last).toBe('24:15');
    expect(dir1.trips).toBe(3);
    expect(dir1.services[0]).toMatchObject({ first: '07:00', last: '23:30', trips: 2 });
    expect(dir1.services[1]).toMatchObject({ first: '24:15', last: '24:15', trips: 1 });
  });

  it('doc de catálogo (sin services/trips): direcciones con first/last null y 0 expediciones', () => {
    const catalogDoc = {
      ...crtmMetroFreqDocFixture(),
      services: undefined,
      trips: undefined,
      noSchedule: { calendarEnd: '20260527', feedVersions: ['20250527'] },
    } as unknown as CRTMLineDoc;

    const directions = buildLineTimetable(catalogDoc);
    expect(directions).toHaveLength(2);
    expect(directions[0]).toMatchObject({ first: null, last: null, trips: 0, services: [] });
  });
});

describe('computeStopDepartures', () => {
  it('devuelve las salidas de la ventana ordenadas, con madrugadas ≥24:00, excepciones y colisiones de label', () => {
    const docs = crtmScheduleDocsFixture();
    const departures = computeStopDepartures(docs, '09568', CRTM_TEST_NOW, 7200, 100);

    // el trip dir 1 termina en 09568 (cabecera): su llegada de las 10:50 NO es salida
    expect(departures.map((d) => d.time)).toEqual(['10:25', '10:30', '11:00', '11:05', '11:10']);
    expect(departures.every((d) => d.dayOffset === 0)).toBe(true);

    // 10:30 llega por el servicio de ayer con hora ≥24:00 (24:15 de ayer)
    const night = departures[1];
    expect(night.routeId).toBe('8__421___');
    expect(night.dir).toBe(0);
    expect(Date.parse(night.departureISO)).toBe(CRTM_TEST_NOW + 15 * 60_000);

    // 11:00 viene del doc urbano con el mismo label '421'
    expect(departures[2]).toMatchObject({
      routeId: '9__421___',
      network: 'urban',
      headsign: 'Estación de Alcorcón',
    });

    // 11:10 pertenece al servicio FESTIVO (solo excepción 1) y cae back al headsign de la dirección
    expect(departures[4].headsign).toBe('Madrid (Moncloa)');

    // el doc 9__999___ (label '421' que no para en 09568) no aporta y el reforzado retirado hoy no aparece
    expect(departures.every((d) => d.routeId !== '9__999___')).toBe(true);
    expect(departures.some((d) => d.time === '10:55')).toBe(false);
  });

  it('respeta la ventana hacia adelante (límite exclusivo)', () => {
    const docs = crtmScheduleDocsFixture();
    const departures = computeStopDepartures(docs, '09568', CRTM_TEST_NOW, 720, 100);
    expect(departures.map((d) => d.time)).toEqual(['10:25']);
  });

  it('limita el número de resultados', () => {
    const docs = crtmScheduleDocsFixture();
    const departures = computeStopDepartures(docs, '09568', CRTM_TEST_NOW, 7200, 2);
    expect(departures).toHaveLength(2);
    expect(departures.map((d) => d.time)).toEqual(['10:25', '10:30']);
  });

  it('doc de catálogo (sin trips): sin salidas y sin fallos', () => {
    const catalogDoc = {
      ...crtmMetroFreqDocFixture(),
      services: undefined,
      trips: undefined,
      noSchedule: { calendarEnd: '20260527', feedVersions: ['20250527'] },
    } as unknown as CRTMLineDoc;

    expect(computeStopDepartures([catalogDoc], '4_250', CRTM_TEST_NOW, 7200, 100)).toEqual([]);
  });

  it('franja 00:00-02:00 Madrid: madrugada del servicio de ayer, de hoy (dayOffset 1) y salidas del día', () => {
    const now = madridInstantFromWall('20260820', 30 * 60); // jueves 00:30 Madrid
    const svcWednesday: CRTMService = {
      id: 'W',
      days: [0, 0, 1, 0, 0, 0, 0],
      from: '20260801',
      to: '20260901',
      exceptions: {},
    }; // 20260819
    const svcThursday: CRTMService = {
      id: 'T',
      days: [0, 0, 0, 1, 0, 0, 0],
      from: '20260801',
      to: '20260901',
      exceptions: {},
    }; // 20260820
    const doc: CRTMLineDoc = {
      routeId: '8__N91__',
      label: 'N91',
      name: 'Nocturno',
      network: 'interurban',
      municipality: 'Madrid',
      url: null,
      directions: [{ id: 0, headsign: 'Moncloa', stops: ['09568'] }],
      services: [svcWednesday, svcThursday],
      trips: [
        { dir: 0, svc: 0, headsign: 'Moncloa', dep: 86400 + 20 * 60, stops: ['09568@0'] }, // miércoles 24:20 → hoy 00:20 (pasado)
        { dir: 0, svc: 0, headsign: 'Moncloa', dep: 86400 + 50 * 60, stops: ['09568@0'] }, // miércoles 24:50 → hoy 00:50
        { dir: 0, svc: 1, headsign: 'Moncloa', dep: 86400 + 10 * 60, stops: ['09568@0'] }, // jueves 24:10 → mañana 00:10
        { dir: 0, svc: 1, headsign: 'Moncloa', dep: 8 * 3600, stops: ['09568@0'] }, // jueves 08:00
      ],
    };

    const departures = computeStopDepartures([doc], '09568', now, 24 * 3600, 100);

    expect(departures.map((d) => [d.time, d.dayOffset])).toEqual([
      ['00:50', 0],
      ['08:00', 0],
      ['00:10', 1],
    ]);
    expect(departures[2].departureISO).toBe(
      new Date(madridInstantFromWall('20260821', 10 * 60)).toISOString(),
    );
  });

  it('línea circular: la parada inicial aporta su salida; la vuelta al punto de partida es llegada, no salida', () => {
    const now = madridInstantFromWall('20260820', 10 * 3600); // 10:00 Madrid
    const svc: CRTMService = {
      id: 'LAB',
      days: [1, 1, 1, 1, 1, 1, 1],
      from: '20260801',
      to: '20260901',
      exceptions: {},
    };
    const doc: CRTMLineDoc = {
      routeId: '9__C1____',
      label: 'C1',
      name: 'Circular',
      network: 'urban',
      municipality: 'Alcorcón',
      url: null,
      directions: [{ id: 0, headsign: 'Circular', stops: ['09568', '08712', '09568'] }],
      services: [svc],
      trips: [
        {
          dir: 0,
          svc: 0,
          headsign: 'Circular',
          dep: 10 * 3600 + 5 * 60,
          stops: ['09568@0', '08712@420', '09568@1800'],
        },
      ],
    };

    const departures = computeStopDepartures([doc], '09568', now, 3600, 100);

    expect(departures.map((d) => d.time)).toEqual(['10:05']);
  });
});

describe('computeStopDayDepartures (modo fecha: tablón de un día completo)', () => {
  it('día completo de mañana: ordenado por hora efectiva, con la madrugada ≥24:00 del servicio de hoy', () => {
    const docs = crtmScheduleDocsFixture();
    const departures = computeStopDayDepartures(docs, '09568', '20260821', 100);

    // 10:30 = madrugada del servicio del jueves (34:30 GTFS); el REFORZADO sí corre el viernes
    // (su excepción 2 solo retira hoy jueves) y el FESTIVO no (excepción 1 solo hoy)
    expect(departures.map((d) => d.time)).toEqual([
      '10:25',
      '10:30',
      '10:55',
      '11:00',
      '11:05',
      '13:15',
    ]);
    expect(departures.every((d) => d.dayOffset === 0)).toBe(true);
    expect(departures.every((d) => d.stale === undefined)).toBe(true);

    expect(departures[1]).toMatchObject({
      routeId: '8__421___',
      dir: 0,
      headsign: 'Madrid (Moncloa)',
    });
    expect(departures[1].departureISO).toBe(
      new Date(madridInstantFromWall('20260821', 10 * 3600 + 30 * 60)).toISOString(),
    );
    expect(departures[2]).toMatchObject({ routeId: '8__421___', time: '10:55' }); // REFORZADO (svc 1)
    expect(departures[3]).toMatchObject({ routeId: '9__421___', network: 'urban' }); // colisión de label
  });

  it('para hoy incluye también las salidas ya pasadas y respeta las excepciones del día', () => {
    const docs = crtmScheduleDocsFixture();
    // 10:30 aquí es la madrugada del servicio del MIÉRCOLES (34:30 del miércoles GTFS);
    // REFORZADO retirado hoy (excepción 2) y FESTIVO añadido hoy (excepción 1)
    const departures = computeStopDayDepartures(docs, '09568', '20260820', 100);

    expect(departures.map((d) => d.time)).toEqual([
      '10:25',
      '10:30',
      '11:00',
      '11:05',
      '11:10',
      '13:15',
    ]);
    expect(departures.some((d) => d.time === '10:55')).toBe(false);
  });

  it('la madrugada ≥24:00 del propio día consultado pertenece al día siguiente, no al consultado', () => {
    const doc = crtmTimetableDocFixture(); // FIN con 24:15 el sábado

    // sábado 22/08: el 24:15 del propio sábado NO está (cae el domingo); el viernes LAB no tiene ≥24:00
    const saturday = computeStopDayDepartures([doc], '09568', '20260822', 100);
    expect(saturday.map((d) => d.time)).toEqual(['08:00', '09:30']);

    // domingo 23/08: el 24:15+600s de offset del servicio del SÁBADO sí está (00:25 del domingo)
    const sunday = computeStopDayDepartures([doc], '09568', '20260823', 100);
    expect(sunday.map((d) => d.time)).toEqual(['00:25', '08:00', '09:30']);
  });

  it('patrón por día de la semana: viernes sirve LAB y sábado sirve FIN', () => {
    const doc = crtmTimetableDocFixture();

    const friday = computeStopDayDepartures([doc], '09568', '20260821', 100);
    expect(friday.map((d) => [d.time, d.dir])).toEqual([
      ['06:00', 0],
      ['06:30', 0],
      ['07:10', 1],
      ['22:00', 0],
      ['23:40', 1],
    ]);

    const saturday = computeStopDayDepartures([doc], '09568', '20260822', 100);
    expect(saturday.every((d) => d.time !== '22:00')).toBe(true); // LAB no circula sábado
  });

  it('fallback de calendario caducado también aplica en modo fecha (sábado futuro sin patrón activo)', () => {
    const doc: CRTMLineDoc = {
      routeId: '9__6__005_',
      label: '6',
      name: 'EST. LA GARENA - VIRGEN DEL VAL',
      network: 'urban',
      municipality: 'Alcalá de Henares',
      url: null,
      directions: [{ id: 0, headsign: 'ÁVILA-MURCIA', stops: ['20789'] }],
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
        { dir: 0, svc: 1, headsign: 'ÁVILA-MURCIA', dep: 20 * 3600 + 30 * 60, stops: ['20789@0'] },
        { dir: 0, svc: 1, headsign: 'ÁVILA-MURCIA', dep: 23 * 3600, stops: ['20789@0'] },
        { dir: 0, svc: 0, headsign: 'ÁVILA-MURCIA', dep: 21 * 3600, stops: ['20789@0'] },
      ],
    };

    const saturday = computeStopDayDepartures([doc], '20789', '20260905', 100);
    expect(saturday.map((d) => [d.time, d.stale ?? false])).toEqual([
      ['20:30', true],
      ['23:00', true],
    ]);

    const friday = computeStopDayDepartures([doc], '20789', '20260904', 100);
    expect(friday.map((d) => [d.time, d.stale ?? false])).toEqual([['21:00', false]]);
  });

  it('frequencies: expande las bandas del día y añade la madrugada del servicio anterior', () => {
    const doc = crtmMetroFreqDocFixture();
    const departures = computeStopDayDepartures([doc], '4_250', '20260821', 100);

    // madrugada del jueves (banda 24:10-24:40 → 00:10, 00:25) + 18 instancias dir 0 + 23:45 dir 1
    expect(departures).toHaveLength(21);
    expect(departures.slice(0, 3).map((d) => d.time)).toEqual(['00:10', '00:25', '10:05']);
    expect(departures.at(-1)).toMatchObject({ time: '23:45', headsign: 'Pinar de Chamartín' });
    expect(departures.some((d) => d.time === '12:33')).toBe(true); // última instancia de la banda de 8 min
    expect(departures.every((d) => d.dayOffset === 0)).toBe(true);
  });

  it('limita el número de resultados tras ordenar', () => {
    const doc = crtmMetroFreqDocFixture();
    expect(computeStopDayDepartures([doc], '4_250', '20260821', 3).map((d) => d.time)).toEqual([
      '00:10',
      '00:25',
      '10:05',
    ]);
  });

  it('doc de catálogo (sin trips): sin salidas y sin fallos', () => {
    const catalogDoc = {
      ...crtmMetroFreqDocFixture(),
      services: undefined,
      trips: undefined,
      noSchedule: { calendarEnd: '20260527', feedVersions: ['20250527'] },
    } as unknown as CRTMLineDoc;

    expect(computeStopDayDepartures([catalogDoc], '4_250', '20260821', 100)).toEqual([]);
  });
});

describe('fallback de calendario caducado (rangos truncados del feed)', () => {
  // patrón real del feed urbano 2026-07-26: la 6 de Alcalá publica sábados solo el 2026-07-25
  // (caso verificado en vivo el 2026-08-29: la parada 20789 quedaba sin salidas los sábados)
  const saturdayNow = madridInstantFromWall('20260829', 20 * 3600 + 23 * 60); // sábado 29/08 20:23 Madrid

  function truncatedCalendarDoc(overrides: Partial<CRTMService> = {}): CRTMLineDoc {
    return {
      routeId: '9__6__005_',
      label: '6',
      name: 'EST. LA GARENA - VIRGEN DEL VAL',
      network: 'urban',
      municipality: 'Alcalá de Henares',
      url: null,
      directions: [{ id: 0, headsign: 'ÁVILA-MURCIA', stops: ['20789'] }],
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
          exceptions: { ...overrides.exceptions },
        },
        {
          id: 'SAB-VIEJO',
          days: [0, 0, 0, 0, 0, 1, 0],
          from: '20250601',
          to: '20250630',
          exceptions: {},
        },
      ],
      trips: [
        { dir: 0, svc: 1, headsign: 'ÁVILA-MURCIA', dep: 20 * 3600 + 30 * 60, stops: ['20789@0'] },
        { dir: 0, svc: 1, headsign: 'ÁVILA-MURCIA', dep: 23 * 3600, stops: ['20789@0'] },
        { dir: 0, svc: 0, headsign: 'ÁVILA-MURCIA', dep: 21 * 3600, stops: ['20789@0'] },
        { dir: 0, svc: 2, headsign: 'ÁVILA-MURCIA', dep: 22 * 3600, stops: ['20789@0'] },
      ],
    };
  }

  it('sábado sin patrón activo: sirve la última generación caducada marcada stale', () => {
    const departures = computeStopDepartures(
      [truncatedCalendarDoc()],
      '20789',
      saturdayNow,
      4 * 3600,
      100,
    );

    expect(departures.map((d) => [d.time, d.stale ?? false])).toEqual([
      ['20:30', true],
      ['23:00', true],
    ]);
  });

  it('el fallback elige la generación caducada más reciente (no la antigua ni el servicio de laborables)', () => {
    const departures = computeStopDepartures(
      [truncatedCalendarDoc()],
      '20789',
      saturdayNow,
      4 * 3600,
      100,
    );

    expect(departures.every((d) => d.time !== '22:00')).toBe(true); // SAB-VIEJO (to 2025)
    expect(departures.every((d) => d.time !== '21:00')).toBe(true); // LAB no circula sábado
  });

  it('excepción 2 sobre la fecha también retira en modo fallback', () => {
    const doc = truncatedCalendarDoc({ exceptions: { 20260829: 2 } });

    expect(computeStopDepartures([doc], '20789', saturdayNow, 4 * 3600, 100)).toEqual([]);
  });

  it('con servicio activo el mismo día no se aplica fallback ni marca stale', () => {
    const fridayNow = madridInstantFromWall('20260828', 20 * 3600 + 23 * 60); // viernes 28/08
    const departures = computeStopDepartures(
      [truncatedCalendarDoc()],
      '20789',
      fridayNow,
      4 * 3600,
      100,
    );

    expect(departures.map((d) => d.time)).toEqual(['21:00']);
    expect(departures.every((d) => d.stale === undefined)).toBe(true);
  });

  it('un servicio que aún no ha empezado no rellena el hueco', () => {
    const doc: CRTMLineDoc = {
      routeId: '9__6__005_',
      label: '6',
      name: 'EST. LA GARENA - VIRGEN DEL VAL',
      network: 'urban',
      municipality: 'Alcalá de Henares',
      url: null,
      directions: [{ id: 0, headsign: 'ÁVILA-MURCIA', stops: ['20789'] }],
      services: [
        {
          id: 'SAB-FUTURO',
          days: [0, 0, 0, 0, 0, 1, 0],
          from: '20260912',
          to: '20270912',
          exceptions: {},
        },
      ],
      trips: [{ dir: 0, svc: 0, headsign: 'ÁVILA-MURCIA', dep: 21 * 3600, stops: ['20789@0'] }],
    };

    expect(computeStopDepartures([doc], '20789', saturdayNow, 4 * 3600, 100)).toEqual([]);
  });

  it('mezcla de docs: el doc con servicio activo aporta normal y el truncado con stale', () => {
    const activeDoc: CRTMLineDoc = {
      routeId: '9__6__148_',
      label: '6',
      name: 'PLAZA DE ESPAÑA - OASIZ',
      network: 'urban',
      municipality: 'Torrejón de Ardoz',
      url: null,
      directions: [{ id: 0, headsign: 'AV.PREMIOS NOBEL-PUENTE', stops: ['20789'] }],
      services: [
        {
          id: 'TODOS',
          days: [1, 1, 1, 1, 1, 1, 1],
          from: '20260723',
          to: '20270823',
          exceptions: {},
        },
      ],
      trips: [
        {
          dir: 0,
          svc: 0,
          headsign: 'AV.PREMIOS NOBEL-PUENTE',
          dep: 20 * 3600 + 40 * 60,
          stops: ['20789@0'],
        },
      ],
    };

    const departures = computeStopDepartures(
      [truncatedCalendarDoc(), activeDoc],
      '20789',
      saturdayNow,
      4 * 3600,
      100,
    );

    expect(departures.map((d) => [d.routeId, d.time, d.stale ?? false])).toEqual([
      ['9__6__005_', '20:30', true],
      ['9__6__148_', '20:40', false],
      ['9__6__005_', '23:00', true],
    ]);
  });
});

describe('destino canónico por cabecera (nombre de línea "A - B")', () => {
  // patrón real de la 6 de Alcalá: cabeceras del nombre vs calles de los headsign GTFS
  const saturdayEvening = madridInstantFromWall('20260829', 20 * 3600); // sábado 29/08 20:00 Madrid
  const stopNames = new Map<string, string>([
    ['20789', 'FERNANDO FERNÁN GÓMEZ-EST.LA GARENA'],
    ['20795', 'CARRETERA DE VALLADOLID-KM.1'],
    ['20790', 'AV. VIRGEN DEL VAL-PZA. SANTOS NIÑOS'],
  ]);
  const stopNameOf = (code: string) => stopNames.get(code);

  function alcalaDoc(): Omit<CRTMLineDoc, 'trips'> & { trips: CRTMTrip[] } {
    return {
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
          id: 'SAB',
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
    };
  }

  it('resolveDirectionDestinations: cada dirección matchea su cabecera (tokens del headsign + parada final)', () => {
    expect(resolveDirectionDestinations(alcalaDoc(), stopNameOf)).toEqual({
      0: 'VIRGEN DEL VAL',
      1: 'EST. LA GARENA',
    });
  });

  it('si solo una dirección matchea, la otra toma la cabecera restante (inferencia)', () => {
    // caso 421: "Moncloa - Boadilla del Monte" con headsigns "Madrid (Moncloa)" / "Boadilla del Monte"
    const doc: CRTMLineDoc = {
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
      services: [],
      trips: [],
    };
    const names = new Map([
      ['09568', 'Pº Extremadura - Av. Portugal'],
      ['09999', 'Intercambiador de Moncloa'],
    ]);

    const resolved = resolveDirectionDestinations(doc, (code) => names.get(code));

    expect(resolved).toEqual({ 0: 'Moncloa', 1: 'Boadilla del Monte' });
  });

  it('nombre sin split A - B limpio (3 partes) no se resuelve', () => {
    const doc: CRTMLineDoc = {
      ...alcalaDoc(),
      name: 'FFCC-CANTOS ALTOS-PUEBLO-ARROYO ARRIBA',
    };

    expect(resolveDirectionDestinations(doc, stopNameOf)).toEqual({});
  });

  it('ambas direcciones matchean la misma cabecera: datos ambiguos, no se toca', () => {
    const doc: CRTMLineDoc = {
      ...alcalaDoc(),
      directions: [
        { id: 0, headsign: 'EST. LA GARENA CENTRO', stops: ['20789'] },
        { id: 1, headsign: 'EST. LA GARENA NORTE', stops: ['20789'] },
      ],
    };

    expect(resolveDirectionDestinations(doc, stopNameOf)).toEqual({});
  });

  it('match de un solo token no resuelve (conservador)', () => {
    const doc: CRTMLineDoc = {
      routeId: '9__6__148_',
      label: '6',
      name: 'PLAZA DE ESPAÑA - OASIZ',
      network: 'urban',
      municipality: 'Torrejón de Ardoz',
      url: null,
      directions: [
        { id: 0, headsign: 'AV.PREMIOS NOBEL-PUENTE', stops: ['10001'] },
        { id: 1, headsign: 'TERMINAL PZA.ESPAÑA-EST.TORREJÓN', stops: ['10002'] },
      ],
      services: [],
      trips: [],
    };

    expect(resolveDirectionDestinations(doc, () => null)).toEqual({});
  });

  it('en cabecera solo hay salidas hacia la otra cabecera y con destino canónico', () => {
    // 20789 = cabecera de EST. LA GARENA: la llegada del dir 1 (22:00) no aparece,
    // las salidas del dir 0 llevan headsign de cabecera, no el de calle (ÁVILA-MURCIA)
    const departures = computeStopDepartures(
      [alcalaDoc()],
      '20789',
      saturdayEvening,
      4 * 3600,
      100,
      stopNameOf,
    );

    expect(departures).toHaveLength(1);
    expect(departures[0]).toMatchObject({ dir: 0, time: '20:30', headsign: 'VIRGEN DEL VAL' });
  });

  it('parada intermedia ve ambas direcciones con destinos de cabecera', () => {
    const departures = computeStopDepartures(
      [alcalaDoc()],
      '20795',
      saturdayEvening,
      4 * 3600,
      100,
      stopNameOf,
    );

    expect(departures.map((d) => [d.dir, d.time, d.headsign])).toEqual([
      [0, '20:40', 'VIRGEN DEL VAL'],
      [1, '21:10', 'EST. LA GARENA'],
    ]);
  });

  it('los trips variante (headsign propio distinto del de su dirección) no toman el destino canónico', () => {
    // caso real: 6 de Alcalá dir 0 con 6 reforzados "ls 6 EST. ALCALÁ DE HENARES" (headsign FERRAZ-GOYA)
    const doc = alcalaDoc();
    doc.trips.push({
      dir: 0,
      svc: 0,
      headsign: 'FERRAZ-GOYA',
      dep: 21 * 3600 + 30 * 60,
      stops: ['20789@0', '20790@900'],
    });

    const departures = computeStopDepartures(
      [doc],
      '20789',
      saturdayEvening,
      4 * 3600,
      100,
      stopNameOf,
    );

    expect(departures.map((d) => [d.time, d.headsign])).toEqual([
      ['20:30', 'VIRGEN DEL VAL'],
      ['21:30', 'FERRAZ-GOYA'],
    ]);
  });

  it('sin resolvedor de nombres se conserva el headsign GTFS (compatibilidad)', () => {
    const departures = computeStopDepartures(
      [alcalaDoc()],
      '20795',
      saturdayEvening,
      4 * 3600,
      100,
    );

    expect(departures.map((d) => d.headsign)).toEqual([
      'ÁVILA-MURCIA',
      'FERNANDO FERNÁN GÓMEZ-EST.LA GARENA',
    ]);
  });
});

describe('dest por trip (trip_short_name limpio del feed)', () => {
  const saturdayEvening = madridInstantFromWall('20260829', 20 * 3600); // sábado 29/08 20:00 Madrid
  const stopNames = new Map<string, string>([
    ['20789', 'FERNANDO FERNÁN GÓMEZ-EST.LA GARENA'],
    ['20795', 'CARRETERA DE VALLADOLID-KM.1'],
    ['20790', 'AV. VIRGEN DEL VAL-PZA. SANTOS NIÑOS'],
  ]);
  const stopNameOf = (code: string) => stopNames.get(code);

  function alcalaDoc(): Omit<CRTMLineDoc, 'trips'> & { trips: CRTMTrip[] } {
    return {
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
          id: 'SAB',
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
    };
  }

  it('modeDestByDirection: dest más frecuente por dirección; sin dest en ningún trip → {}', () => {
    const doc = alcalaDoc();
    doc.trips.push({
      dir: 0,
      svc: 0,
      headsign: 'ÁVILA-MURCIA',
      dest: 'VIRGEN DEL VAL (sin paso por Colegios)',
      dep: 20 * 3600 + 50 * 60,
      stops: ['20789@0', '20790@900'],
    });
    doc.trips.push({
      dir: 0,
      svc: 0,
      headsign: 'ÁVILA-MURCIA',
      dest: 'VIRGEN DEL VAL',
      dep: 21 * 3600 + 10 * 60,
      stops: ['20789@0', '20790@900'],
    });
    doc.trips.push({
      dir: 0,
      svc: 0,
      headsign: 'ÁVILA-MURCIA',
      dest: 'VIRGEN DEL VAL',
      dep: 21 * 3600 + 40 * 60,
      stops: ['20789@0', '20790@900'],
    });

    expect(modeDestByDirection(doc)).toEqual({ 0: 'VIRGEN DEL VAL' });
    expect(modeDestByDirection(alcalaDoc())).toEqual({});
  });

  it('el dest del trip gana sobre cabecera heurística y headsign, también en variantes ocultas', () => {
    const doc = alcalaDoc();
    doc.trips[0] = { ...doc.trips[0], dest: 'VIRGEN DEL VAL' }; // normal con dest
    // reforzado "ls" (headsign propio de calle) con dest canónico
    doc.trips.push({
      dir: 0,
      svc: 0,
      headsign: 'FERRAZ-GOYA',
      dest: 'EST. ALCALÁ DE HENARES',
      dep: 20 * 3600 + 45 * 60,
      stops: ['20789@0', '20790@900'],
    });
    // variante oculta: headsign = el de su dirección pero destino distinto (8,9% de los interurbanos)
    doc.trips.push({
      dir: 0,
      svc: 0,
      headsign: 'ÁVILA-MURCIA',
      dest: 'VIRGEN DEL VAL (sin paso por Colegios)',
      dep: 21 * 3600 + 15 * 60,
      stops: ['20789@0', '20790@900'],
    });

    const departures = computeStopDepartures(
      [doc],
      '20789',
      saturdayEvening,
      4 * 3600,
      100,
      stopNameOf,
    );

    expect(departures.map((d) => [d.time, d.headsign])).toEqual([
      ['20:30', 'VIRGEN DEL VAL'],
      ['20:45', 'EST. ALCALÁ DE HENARES'],
      ['21:15', 'VIRGEN DEL VAL (sin paso por Colegios)'],
    ]);
  });

  it('trip sin dest conserva la cadena heurística (docs pre-refresco y ml/metro)', () => {
    const departures = computeStopDepartures(
      [alcalaDoc()],
      '20795',
      saturdayEvening,
      4 * 3600,
      100,
      stopNameOf,
    );

    expect(departures.map((d) => d.headsign)).toEqual(['VIRGEN DEL VAL', 'EST. LA GARENA']);
  });

  it('trip plantilla (frequencies) con dest: todas las instancias materializadas lo llevan', () => {
    const doc: CRTMLineDoc = {
      routeId: '4__1_____',
      label: '1',
      name: 'Metro L1 Pinar de Chamartín - Valdecarros',
      network: 'metro',
      municipality: 'Madrid',
      url: null,
      directions: [{ id: 0, headsign: 'Valdecarros', stops: ['4_250'] }],
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
          headsign: 'Valdecarros',
          dest: 'VALDECARROS',
          freq: [{ from: 20 * 3600 + 30 * 60, to: 20 * 3600 + 50 * 60, headway: 600 }],
          stops: ['4_250@0'],
        },
      ],
    };

    const departures = computeStopDepartures([doc], '4_250', saturdayEvening, 3600, 100);

    // banda [20:30, 20:50) cada 10 min → to exclusivo: solo 20:30 y 20:40
    expect(departures.map((d) => [d.time, d.headsign])).toEqual([
      ['20:30', 'VALDECARROS'],
      ['20:40', 'VALDECARROS'],
    ]);
  });
});

describe('frequencies (trips plantilla de metro)', () => {
  it('freqBandInstances: n en [from, to) cada headway; bandas degeneradas y headway inválido → 0', () => {
    expect(freqBandInstances({ from: 3600, to: 3600 + 6 * 600, headway: 600 })).toBe(6);
    expect(freqBandInstances({ from: 3600, to: 3600 + 5999, headway: 600 })).toBe(10); // la última instancia cabe justo antes de to
    expect(freqBandInstances({ from: 3600, to: 3600, headway: 600 })).toBe(0);
    expect(freqBandInstances({ from: 3600, to: 7200, headway: 0 })).toBe(0);
  });

  it('expande bandas en query time con offsets de parada y ventana hacia adelante', () => {
    const doc = crtmMetroFreqDocFixture();
    const departures = computeStopDepartures([doc], '4_250', CRTM_TEST_NOW, 7200, 100);

    expect(departures.map((d) => d.time)).toEqual([
      '10:15',
      '10:25',
      '10:35',
      '10:45',
      '10:55',
      '11:05',
      '11:13',
      '11:21',
      '11:29',
      '11:37',
      '11:45',
      '11:53',
      '12:01',
      '12:09',
    ]);
    expect(
      departures.every((d) => d.network === 'metro' && d.line === '1' && d.dayOffset === 0),
    ).toBe(true);
    expect(departures.every((d) => d.headsign === 'Valdecarros')).toBe(true);
  });

  it('bandas adyacentes no duplican la salida del borde (to exclusivo)', () => {
    const doc = crtmMetroFreqDocFixture();
    // banda 1 termina en 11:00 y banda 2 empieza en 11:00: en la parada, 10:55 (última de la 1)
    // y 11:05 (primera de la 2); 11:00 como instancia no existe y no hay duplicado
    const departures = computeStopDepartures([doc], '4_250', CRTM_TEST_NOW, 7200, 100);
    expect(departures.filter((d) => d.time === '10:55')).toHaveLength(1);
    expect(departures.some((d) => d.time === '11:00')).toBe(false);
  });

  it('respeta el límite exclusivo de la ventana', () => {
    const doc = crtmMetroFreqDocFixture();
    // cutoff 10:30: la instancia 10:30 queda fuera
    expect(
      computeStopDepartures([doc], '4_250', CRTM_TEST_NOW, 900, 100).map((d) => d.time),
    ).toEqual(['10:15', '10:25']);
  });

  it('madrugada ≥24:00 en bandas: servicio de ayer → dayOffset 0, servicio de hoy → dayOffset 1', () => {
    const now = madridInstantFromWall('20260820', 30 * 60); // jueves 00:30 Madrid
    const svcWednesday: CRTMService = {
      id: 'W',
      days: [0, 0, 1, 0, 0, 0, 0],
      from: '20260801',
      to: '20260901',
      exceptions: {},
    };
    const svcThursday: CRTMService = {
      id: 'T',
      days: [0, 0, 0, 1, 0, 0, 0],
      from: '20260801',
      to: '20260901',
      exceptions: {},
    };
    const doc: CRTMLineDoc = {
      routeId: '4__1_____',
      label: '1',
      name: 'Metro L1',
      network: 'metro',
      municipality: 'Madrid',
      url: null,
      directions: [{ id: 0, headsign: 'Valdecarros', stops: ['4_250'] }],
      services: [svcWednesday, svcThursday],
      trips: [
        {
          dir: 0,
          svc: 0,
          headsign: 'Valdecarros',
          freq: [{ from: 86400 + 20 * 60, to: 86400 + 50 * 60, headway: 1500 }],
          stops: ['4_250@0'],
        }, // miércoles 24:20, 24:45
        {
          dir: 0,
          svc: 1,
          headsign: 'Valdecarros',
          freq: [{ from: 86400 + 10 * 60, to: 86400 + 40 * 60, headway: 900 }],
          stops: ['4_250@0'],
        }, // jueves 24:10, 24:25
      ],
    };

    const departures = computeStopDepartures([doc], '4_250', now, 24 * 3600, 100);

    expect(departures.map((d) => [d.time, d.dayOffset])).toEqual([
      ['00:45', 0], // madrugada de hoy, servicio del miércoles (24:45 de ayer)
      ['00:10', 1], // madrugada de mañana, servicio del jueves
      ['00:25', 1],
    ]);
    expect(departures[1].departureISO).toBe(
      new Date(madridInstantFromWall('20260821', 10 * 60)).toISOString(),
    );
  });

  it('banda degenerada (from == to) no genera salidas y no rompe la run', () => {
    const now = madridInstantFromWall('20260820', 10 * 3600);
    const svc: CRTMService = {
      id: 'X',
      days: [1, 1, 1, 1, 1, 1, 1],
      from: '20260801',
      to: '20260901',
      exceptions: {},
    };
    const doc: CRTMLineDoc = {
      routeId: '4__1_____',
      label: '1',
      name: 'Metro L1',
      network: 'metro',
      municipality: 'Madrid',
      url: null,
      directions: [{ id: 0, headsign: 'Valdecarros', stops: ['4_250'] }],
      services: [svc],
      trips: [
        {
          dir: 0,
          svc: 0,
          headsign: 'Valdecarros',
          freq: [{ from: 10 * 3600, to: 10 * 3600, headway: 600 }],
          stops: ['4_250@0'],
        },
      ],
    };
    expect(computeStopDepartures([doc], '4_250', now, 3600, 100)).toEqual([]);
  });

  it('buildLineTimetable expande: primero/último instancia y nº de expediciones materializadas', () => {
    const directions = buildLineTimetable(crtmMetroFreqDocFixture());

    const dir0 = directions[0];
    expect(dir0.first).toBe('10:00');
    expect(dir0.last).toBe('12:28'); // última instancia de la banda de 8 min, no su to (12:30)
    expect(dir0.trips).toBe(18); // 6 (banda 10:00-11:00) + 12 (banda 11:00-12:30)
    expect(dir0.services[0]).toMatchObject({ first: '10:00', last: '12:28', trips: 18 });

    // dir 1 mezcla trip explícito (23:45) y plantilla (24:10, 24:25)
    const dir1 = directions[1];
    expect(dir1.first).toBe('23:45');
    expect(dir1.last).toBe('24:25');
    expect(dir1.trips).toBe(3);
    expect(dir1.services).toHaveLength(1);
  });
});

describe('widgetDestinations / resolveWidgetDest (dest canónico del board RT)', () => {
  const doc: CRTMLineDoc = {
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
      { id: 'LAB', days: [1, 1, 1, 1, 1, 1, 1], from: '20260813', to: '20260827', exceptions: {} },
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
  };
  const stopNameOf = (code: string) =>
    (
      ({
        '06994': 'AV.REYES CATÓLICOS-VIVEROS',
        '06993': 'ÁVILA-MURCIA',
        '06991': 'FERNANDO FERNÁN GÓMEZ-EST.LA GARENA',
      }) as Record<string, string>
    )[code] ?? null;

  it('mode(dest) por dirección gana; sin dest en los trips cae a la cabecera del nombre', () => {
    const dests = widgetDestinations(doc, stopNameOf);
    expect(dests.byDir[0].canonical).toBe('VIRGEN DEL VAL');
    expect(dests.byDir[1].canonical).toBe('EST. LA GARENA (c.Colegios peatonal)');

    const noTripDest: CRTMLineDoc = {
      ...doc,
      name: 'Moncloa - Boadilla del Monte',
      directions: [
        { id: 0, headsign: 'Madrid (Moncloa)', stops: ['09568', '09999'] },
        { id: 1, headsign: 'Boadilla del Monte', stops: ['09999', '09568'] },
      ],
      trips: [
        { dir: 0, svc: 0, headsign: 'Madrid (Moncloa)', dep: 0, stops: ['09568@0', '09999@600'] },
      ],
    };
    const names: Record<string, string> = {
      '09568': 'Pº Extremadura - Av. Portugal',
      '09999': 'Intercambiador de Moncloa',
    };
    const byHalves = widgetDestinations(noTripDest, (code) => names[code] ?? null);
    expect(byHalves.byDir[1].canonical).toBe('Boadilla del Monte'); // resuelta por tokens (2)
    expect(byHalves.byDir[0].canonical).toBe('Moncloa'); // la otra dirección toma la cabecera restante
  });

  it('la guarda solo reescribe cuando el dest del SAE es la terminal del sentido', () => {
    const dests = widgetDestinations(doc, stopNameOf);

    // dest del SAE = headsign GTFS de la dirección
    expect(resolveWidgetDest(dests, 0, 'ÁVILA-MURCIA')).toBe('VIRGEN DEL VAL');
    // dest del SAE = nombre de la parada terminal (puntuación/caja distintas, misma clave de tokens)
    expect(resolveWidgetDest(dests, 1, 'FERNANDO FERNÁN GÓMEZ-EST.LA GARENA')).toBe(
      'EST. LA GARENA (c.Colegios peatonal)',
    );
    // variante corta real: dest de una parada intermedia → se conserva (null = no reescribir)
    expect(resolveWidgetDest(dests, 0, 'EST. ALCALÁ D. JUAN CARLOS')).toBeNull();
    // dir invertido en el SAE: el dest casa con la terminal del OTRO sentido → no se toca
    expect(resolveWidgetDest(dests, 1, 'ÁVILA-MURCIA')).toBeNull();
    // dest null del SAE → canónico directo
    expect(resolveWidgetDest(dests, 0, null)).toBe('VIRGEN DEL VAL');
    // dir/dests ausentes
    expect(resolveWidgetDest(dests, 5, 'ÁVILA-MURCIA')).toBeNull();
    expect(resolveWidgetDest(null, 0, 'ÁVILA-MURCIA')).toBeNull();
    expect(resolveWidgetDest(dests, null, 'ÁVILA-MURCIA')).toBeNull();
  });

  it('sin resolución fiable (circular, cabeceras de un token) → canonical null y dest intacto', () => {
    const circular: CRTMLineDoc = {
      routeId: '9__421___',
      label: '421',
      name: 'Circular Alcorcón',
      network: 'urban',
      municipality: 'Alcorcón',
      url: null,
      directions: [{ id: 0, headsign: 'Estación de Alcorcón', stops: ['08712'] }],
      services: [],
      trips: [],
    };
    const dests = widgetDestinations(circular, () => 'Av. Europa - C. Mayor');
    expect(dests.byDir[0].canonical).toBeNull();
    expect(resolveWidgetDest(dests, 0, 'ESTACIÓN DE ALCORCÓN')).toBeNull();
  });
});
