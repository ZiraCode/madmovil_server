import type {
  EMTStopsResponse,
  EMTLinesResponse,
  EMTLineDetailResponse,
  EMTStopDetailResponse,
  EMTCalendarResponse,
  EMTArrive,
  EMTArrivesResponse,
  EMTLineRouteResponse,
  EMTIncidentsResponse,
} from '../../src/types/emt-data';

export function loginResponse(accessToken = 'emt-token-abc') {
  return {
    code: '00',
    description: 'OK',
    datetime: '2026-08-15',
    data: [{ accessToken }],
  };
}

export function stopsResponse() {
  return {
    code: '00',
    description: 'OK',
    datetime: '2026-08-15',
    data: [
      {
        node: '123',
        name: 'Plaza de Sol',
        wifi: '',
        geometry: { type: 'Point', coordinates: [-3.7038, 40.4172] },
        lines: ['1', '2'],
      },
      {
        node: '456',
        name: 'Gran Via - Montera',
        geometry: { type: 'Point', coordinates: [-3.7099, 40.4201] },
        lines: ['5'],
      },
    ],
  } satisfies EMTStopsResponse;
}

export function linesResponse() {
  return {
    code: '00',
    description: 'OK',
    datetime: '2026-08-15',
    data: [
      {
        line: '001',
        label: '1',
        nameA: 'Prosperidad',
        nameB: 'Princesa',
        group: 'EMT',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        longLine1: 100,
        longLine2: 100,
        order: 1,
        color: '#53418F',
      },
      {
        line: '068',
        label: '68',
        nameA: 'Mirasierra',
        nameB: 'Atocha',
        group: 'EMT',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        longLine1: 120,
        longLine2: 120,
        order: 2,
        color: '#53418F',
      },
    ],
  } satisfies EMTLinesResponse;
}

function direction(startTime: string, stopTime: string) {
  return {
    StartTime: startTime,
    StopTime: stopTime,
    MinimunFrequency: '6',
    MaximumFrequency: '12',
    FrequencyText: '6-12 min',
  };
}

export function lineDetailResponse(lineId: string, label: string) {
  return {
    code: '00',
    description: 'OK',
    datetime: '2026-08-15',
    data: [
      {
        line: lineId,
        nameA: 'Cabecera A',
        nameB: 'Cabecera B',
        dateRef: '2026-08-15',
        label,
        timeTable: [
          {
            idDayType: 'LA',
            Direction1: direction('07:00', '23:00'),
            Direction2: direction('07:10', '23:10'),
          },
          {
            idDayType: 'SA',
            Direction1: direction('08:00', '23:00'),
            Direction2: direction('08:10', '23:10'),
          },
          {
            idDayType: 'FE',
            Direction1: direction('09:00', '22:00'),
            Direction2: direction('09:10', '22:10'),
          },
        ],
      },
    ],
  } satisfies EMTLineDetailResponse;
}

export function stopDetailResponse(stopId: string) {
  return {
    code: '00',
    description: 'OK',
    datetime: '2026-08-15',
    data: [
      {
        stops: [
          {
            stop: stopId,
            name: 'Plaza de Sol',
            postalAddress: 'Calle Mayor 1',
            geometry: { type: 'Point', coordinates: [-3.7038, 40.4172] },
            pmv: '1234',
            dataLine: [
              {
                line: '001',
                label: '1',
                direction: 'Princesa',
                maxFreq: '12',
                minFreq: '6',
                headerA: 'Prosperidad',
                headerB: 'Princesa',
                startTime: '07:00',
                stopTime: '23:00',
                dayType: 'LA',
              },
            ],
          },
        ],
      },
    ],
  } satisfies EMTStopDetailResponse;
}

export function calendarResponse() {
  return {
    code: '00',
    description: 'OK',
    datetime: '2026-08-15',
    data: [
      { dayDate: '2026-08-14', dayType: 'LA' },
      { dayDate: '2026-08-15', dayType: 'SA' },
      { dayDate: '2026-08-16', dayType: 'FE' },
      { dayDate: '2026-08-17', dayType: 'XX' },
    ],
  } satisfies EMTCalendarResponse;
}

export function arrivesResponse() {
  function arrive(
    line: string,
    destination: string,
    estimateArrive: number,
    DistanceBus: number,
    bus: number,
    geometry?: EMTArrive['geometry'],
  ): EMTArrive {
    return {
      line,
      stop: '62',
      isHead: 'False',
      destination,
      deviation: 0,
      bus,
      geometry:
        geometry === undefined ? { type: 'Point', coordinates: [-3.6928, 40.4131] } : geometry,
      estimateArrive,
      DistanceBus,
      positionTypeBus: '0',
    };
  }

  return {
    code: '00',
    description: 'Data recovered OK',
    datetime: '2026-08-15T07:07:44.352933',
    data: [
      {
        Arrive: [
          arrive('45', 'REINA VICTORIA', 999999, 2400, 6746, {
            type: 'Point',
            coordinates: [-3.7012, 40.421],
          }),
          arrive('5', 'CHAMARTIN', 74, 319, 4849),
          arrive('5', 'CHAMARTIN', 620, 900, 4850),
          arrive('45', 'REINA VICTORIA', 71, 363, 6746),
          arrive('150', 'VIRGEN CORTIJO', 950, 3800, 8199, null),
        ],
      },
    ],
  } satisfies EMTArrivesResponse;
}

function routeFeatureCollection() {
  return {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        properties: { id: 5, name: 'Calle de López de Hoyos', stroke: '#43b433' },
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [-3.67468, 40.44386],
              [-3.67533, 40.44336],
            ],
          ],
        },
      },
    ],
  };
}

export function lineRouteResponse(label = '1', line = '001') {
  return {
    code: '00',
    description: 'Data recovered OK',
    datetime: '2026-08-15',
    data: {
      label,
      line,
      nameSectionA: 'PROSPERIDAD',
      nameSectionB: 'PLAZA DE CRISTO REY',
      itinerary: { toA: routeFeatureCollection(), toB: routeFeatureCollection() },
      stops: {
        toA: {
          type: 'FeatureCollection' as const,
          features: [
            {
              type: 'Feature' as const,
              properties: { stopNum: 273, stopName: 'Prosperidad', distance: 0 },
              geometry: { type: 'Point', coordinates: [-3.67489, 40.4437] },
            },
          ],
        },
        toB: {
          type: 'FeatureCollection' as const,
          features: [
            {
              type: 'Feature' as const,
              properties: { stopNum: 4514, stopName: 'Cristo Rey', distance: 0 },
              geometry: { type: 'Point', coordinates: [-3.71792, 40.43838] },
            },
          ],
        },
      },
    },
  } satisfies EMTLineRouteResponse;
}

export function lineRouteEmptyResponse() {
  return {
    code: '00',
    description: 'Data recovered OK',
    datetime: '2026-08-15',
    data: {} as EMTLineRouteResponse['data'],
  };
}

const MADRID_WALL_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

// Instante → fecha local Madrid en formato EMT dd/MM/yyyy H:mm:ss
function madridDateString(instant: number): string {
  const parts = MADRID_WALL_FORMAT.formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

const DAY_MS = 24 * 3600_000;

/**
 * Feed de incidencias con fechas relativas a ahora (los tests de vigencia no caducan):
 * - active-5: category '5' (string), ventana activa (empezó ayer, acaba mañana), enclosure con PDF
 * - upcoming-5-150: category ['5','150'] (array), ventana futura (de aquí a 3 días), solo link
 * - expired-148: category ['148'], ventana caducada (acabó ayer)
 * - no-dates-N13: category 'N13', sin fechas de afectación
 */
export function incidentsResponse() {
  const now = Math.floor(Date.now() / 1000) * 1000; // precisión de segundos: el formato EMT no conserva milisegundos
  const instants = {
    activeStart: now - DAY_MS,
    activeEnd: now + DAY_MS,
    upcomingStart: now + 3 * DAY_MS,
    upcomingEnd: now + 4 * DAY_MS,
    expiredStart: now - 2 * DAY_MS,
    expiredEnd: now - DAY_MS,
    published: now - 2 * 3600_000,
  };

  const response = {
    code: '00',
    description: 'Data recovered OK',
    datetime: '2026-08-17',
    data: [
      {
        lastBuildDate: 'Mon, 17 Aug 2026 10:53:13 GMT',
        title: 'Canal de Noticias de la Empresa Municipal de Transportes de Madrid',
        item: [
          {
            guid: 'active-5',
            title: 'Obras: Cedaceros 1. Afectada línea 5 de EMT.',
            description: 'La línea 5 tendrá retenciones por obras.',
            link: 'http://feeds.emtmadrid.es:8082/docs/obras-cedaceros.pdf',
            author: 'cgi@emtmadrid.es',
            pubDate: new Date(instants.published).toUTCString(),
            rssfinaldate: madridDateString(now + 20 * DAY_MS),
            rssAfectaDesde: madridDateString(instants.activeStart),
            rssAfectaHasta: madridDateString(instants.activeEnd),
            GoogleTransitCause: '08 - Obras',
            GoogleTransitEffect: '05 - Desvío programado',
            category: '5',
            enclosure: {
              '@url': 'http://feeds.emtmadrid.es:8082/docs/obras-cedaceros.pdf',
              '@type': 'application/pdf',
              '@length': '87532',
            },
          },
          {
            guid: 'upcoming-5-150',
            title: 'Manifestación en zona Centro. Afectadas 2 líneas de EMT.',
            description: 'Las líneas 5 y 150 modifican su itinerario.',
            link: 'http://feeds.emtmadrid.es:8082/docs/manifestacion-centro.pdf',
            author: 'cgi@emtmadrid.es',
            pubDate: new Date(instants.published).toUTCString(),
            rssAfectaDesde: madridDateString(instants.upcomingStart),
            rssAfectaHasta: madridDateString(instants.upcomingEnd),
            GoogleTransitCause: '01 - Manifestación',
            GoogleTransitEffect: '05 - Desvío programado',
            category: ['5', '150'],
          },
          {
            guid: 'expired-148',
            title: 'Concentración en Alcalá. Afectadas líneas de EMT.',
            description: 'Aviso caducado que sigue publicado en el feed.',
            pubDate: new Date(instants.published).toUTCString(),
            rssAfectaDesde: madridDateString(instants.expiredStart),
            rssAfectaHasta: madridDateString(instants.expiredEnd),
            GoogleTransitCause: '01 - Concentración',
            GoogleTransitEffect: '03 - Detour',
            category: ['148'],
          },
          {
            guid: 'no-dates-N13',
            title: 'Aviso general sin fechas de afectación.',
            description: 'Aviso permanente sin ventana temporal.',
            GoogleTransitCause: null,
            GoogleTransitEffect: null,
            category: 'N13',
          },
        ],
      },
    ],
  } satisfies EMTIncidentsResponse;

  return { response, instants };
}

export function incidentsEmptyResponse() {
  return {
    code: '00',
    description: 'Data recovered OK',
    datetime: '2026-08-17',
    data: [{ lastBuildDate: 'Mon, 17 Aug 2026 10:53:13 GMT', item: [] }],
  } satisfies EMTIncidentsResponse;
}
