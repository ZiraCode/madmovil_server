export interface Stop {
  stopId: string;
  name: string;
  coordinates: {
    latitude: number;
    longitude: number;
  };
  lines: string[];
}

export interface Line {
  lineId: string;
  label: string;
  nameA: string;
  nameB: string;
  group?: string;
  color?: string;
}

export interface EMTStopsResponse {
  code: string;
  description: string;
  datetime: string;
  data: Array<{
    node: string;
    name: string;
    wifi?: string;
    geometry: {
      type: string;
      coordinates: [number, number];
    };
    lines: string[];
  }>;
}

export interface EMTLinesResponse {
  code: string;
  description: string;
  datetime: string;
  data: Array<{
    line: string;
    label: string;
    nameA: string;
    nameB: string;
    group: string;
    startDate: string;
    endDate: string;
    longLine1: number;
    longLine2: number;
    order: number;
    color: string;
  }>;
}

export interface DirectionInfo {
  StartTime: string;
  StopTime: string;
  MinimunFrequency: string;
  MaximumFrequency: string;
  FrequencyText: string;
}

export interface TimeTableEntry {
  idDayType: string; // FE = Festivo, LA = Laborable, SA = Sábado
  Direction1: DirectionInfo;
  Direction2: DirectionInfo;
}

export interface LineDetail {
  lineId: string;
  label: string;
  nameA: string;
  nameB: string;
  dateRef: string;
  timeTable: TimeTableEntry[];
}

export interface EMTLineDetailResponse {
  code: string;
  description: string;
  datetime: string;
  data: Array<{
    line: string;
    nameA: string;
    nameB: string;
    dateRef: string;
    label: string;
    timeTable: TimeTableEntry[];
  }>;
}

export interface StopLineInfo {
  line: string;
  label: string;
  direction: string;
  maxFreq: string;
  minFreq: string;
  headerA: string;
  headerB: string;
  startTime: string;
  stopTime: string;
  dayType: string;
}

export interface StopDetail {
  stopId: string;
  name: string;
  postalAddress: string;
  coordinates: {
    latitude: number;
    longitude: number;
  };
  pmv: string;
  lines: StopLineInfo[];
}

export interface EMTStopDetailResponse {
  code: string;
  description: string;
  datetime: string;
  data: Array<{
    stops: Array<{
      stop: string;
      name: string;
      postalAddress: string;
      geometry: {
        type: string;
        coordinates: [number, number];
      };
      pmv: string;
      dataLine: StopLineInfo[];
    }>;
  }>;
}

// Tipos de día en el calendario EMT
export type DayType = 'laboral' | 'sabado' | 'festivo';

// Calendario anual de la EMT: Record<fecha, tipo de día>
// Fecha en formato YYYY-MM-DD, ejemplo: "2025-01-01"
export type Calendar = Record<string, DayType>;

// Respuesta de la API del calendario EMT
export interface EMTCalendarResponse {
  code: string;
  description: string;
  datetime: string;
  data: Array<{
    dayDate: string; // Formato YYYY-MM-DD
    dayType: string; // "LA" = laboral, "SA" = sábado, "FE" = festivo
  }>;
}

// Horarios de una línea según tipo de día
export interface LineTimetable {
  lineId: string;
  schedules: {
    laboral?: DirectionInfo[];
    sabado?: DirectionInfo[];
    festivo?: DirectionInfo[];
  };
}

// FeatureCollection GeoJSON genérica (la EMT la usa para itinerarios y stops de línea)
export interface GeoJSONFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: Record<string, unknown>;
    geometry: {
      type: string;
      coordinates: unknown;
    };
  }>;
}

// Respuesta del endpoint de ruta de línea (v1, resuelve por LABEL)
export interface EMTLineRouteResponse {
  code: string;
  description: string;
  datetime: string;
  data: {
    label: string;
    line: string;
    nameSectionA: string;
    nameSectionB: string;
    itinerary: {
      toA: GeoJSONFeatureCollection;
      toB: GeoJSONFeatureCollection;
    };
    stops: {
      toA: GeoJSONFeatureCollection;
      toB: GeoJSONFeatureCollection;
    };
  };
}

// Ruta de línea normalizada para el frontend (GeoJSON crudo por dirección)
export interface LineRoute {
  label: string;
  lineId: string;
  nameA: string;
  nameB: string;
  itinerary: {
    toA: GeoJSONFeatureCollection;
    toB: GeoJSONFeatureCollection;
  };
  stops: {
    toA: GeoJSONFeatureCollection;
    toB: GeoJSONFeatureCollection;
  };
}

// Estimación de llegada de un autobús, tal como la devuelve la API EMT.
// geometry es nullable: la EMT la omite para buses sin posición (busPosition: null es un
// caso soportado y servido — ver getArrivals)
export interface EMTArrive {
  line: string;
  stop: string;
  isHead: string;
  destination: string;
  deviation: number;
  bus: number;
  geometry: {
    type: string;
    coordinates: [number, number]; // [longitude, latitude]
  } | null;
  estimateArrive: number; // segundos (999999 = más de 45 min en líneas convencionales)
  DistanceBus: number; // metros del bus a la parada
  positionTypeBus: string;
}

// Respuesta del endpoint de arrives (POST /stops/<stopId>/arrives/<line>/)
export interface EMTArrivesResponse {
  code: string;
  description: string;
  datetime: string;
  data: Array<{
    Arrive: EMTArrive[];
  }>;
}

// Estimación de llegada normalizada para el frontend
export interface BusArrival {
  line: string;
  destination: string;
  estimateArriveSec: number;
  arrivesInMin: number | null; // null = más de 45 min
  distanceM: number;
  busId: number | null;
  busPosition: {
    latitude: number;
    longitude: number;
  } | null;
}

// Item del feed de incidencias de la EMT (v1 lines/incidents/<lineid>/, lineid=all devuelve todo)
export interface EMTIncidentItem {
  guid: string;
  title: string;
  description: string;
  link?: string | null;
  author?: string | null;
  pubDate?: string | null; // RFC 822 (ej: "Mon, 17 Aug 2026 10:53:13 GMT")
  rssfinaldate?: string | null; // dd/MM/yyyy H:mm:ss (hora Madrid)
  rssAfectaDesde?: string | null; // dd/MM/yyyy H:mm:ss (hora Madrid)
  rssAfectaHasta?: string | null; // dd/MM/yyyy H:mm:ss (hora Madrid)
  GoogleTransitCause?: string | null;
  GoogleTransitEffect?: string | null;
  category: string | string[]; // inconsistente en la API: string si afecta a 1 línea, array si a varias
  enclosure?: {
    '@url'?: string;
    '@type'?: string;
    '@length'?: string;
  } | null;
}

// Respuesta del endpoint de incidencias (data[0] es un feed tipo RSS serializado a JSON)
export interface EMTIncidentsResponse {
  code: string;
  description: string;
  datetime: string;
  data: Array<{
    lastBuildDate?: string;
    title?: string;
    item?: EMTIncidentItem[];
  }>;
}

// Incidencia normalizada para el frontend
export interface LineIncident {
  id: string;
  title: string;
  description: string;
  lines: string[];
  cause: string | null;
  effect: string | null;
  startsAt: string | null; // ISO 8601
  endsAt: string | null; // ISO 8601
  publishedAt: string | null; // ISO 8601
  documentUrl: string | null;
}

// Feed de incidencias cacheado en KV
export interface IncidentsFeed {
  lastBuildDate: string | null;
  incidents: LineIncident[];
}
