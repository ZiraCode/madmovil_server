// Tipos de los artefactos CRTM escritos en KV por scripts/crtm-ingest.mjs (prefijo crtm:*)

// interurban/urban = bus (M8/M9); ml = Metro Ligero (M10); metro = Metro (M4);
// cercanias = Renfe Cercanías Madrid (núcleo 10T, GTFS del NAP agrupado por línea)
export type CRTMNetwork = 'interurban' | 'urban' | 'ml' | 'metro' | 'cercanias';

// Item de crtm:stops:all
export interface CRTMStop {
  code: string;
  name: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
  zone: string | null;
  municipality: string | null;
  lines: string[]; // labels de las líneas que sirven la parada
}

// Item de crtm:lines:all (chips del frontend)
export interface CRTMLineSummary {
  label: string;
  routeId: string;
  name: string;
  network: CRTMNetwork;
  municipality: string | null;
  url: string | null;
  color?: string | null; // RRGGBB sin # (solo ml/metro lo publican; ausente en bus)
  textColor?: string | null;
  noSchedule?: true; // red en modo catálogo (feed stale): línea visible sin horarios oficiales
}

export interface CRTMLinesAll {
  count: number;
  lines: CRTMLineSummary[];
}

// Patrón de calendario GTFS (calendar + calendar_dates fusionados)
export interface CRTMService {
  id: string;
  days: number[]; // [lunes..domingo], 1 = circula
  from: string | null; // YYYYMMDD (null = servicio definido solo por excepciones)
  to: string | null;
  exceptions: Record<string, 1 | 2>; // fecha YYYYMMDD → 1 añadido, 2 retirado
}

export interface CRTMDirection {
  id: number; // 0 | 1
  headsign: string;
  stops: string[]; // códigos de parada en orden
}

// Banda de frequencies.txt GTFS: el trip plantilla repite salida cada headway s en [from, to)
export interface CRTMFreqBand {
  from: number; // segundos desde medianoche del día de servicio (≥86400 = madrugada del día siguiente)
  to: number; // exclusive (bandas adyacentes no duplican la salida del borde)
  headway: number; // segundos entre salidas
}

export interface CRTMTrip {
  dir: number;
  svc: number; // índice en services
  headsign: string;
  dest?: string; // destino canónico por trip (trip_short_name limpio del feed; solo bus — refresco 2026-08-30)
  tid?: string; // trip_id GTFS original (solo cercanías — refresco 2026-08-31): join exacto con el GTFS-RT de Renfe
  dep?: number; // horario exacto: segundos desde medianoche del día de servicio
  freq?: CRTMFreqBand[]; // trip plantilla de frequencies.txt (metro): dep se omite, se expande en query time
  stops: string[]; // 'code@offsetSegundos' respecto a dep o al inicio de banda
}

// Marcador de red en modo catálogo (feed con calendario caducado): la línea existe
// (direcciones/secuencia de paradas) pero el feed no publica horarios vigentes
export interface CRTMNoSchedule {
  calendarEnd: string | null; // YYYYMMDD del último día de servicio publicado (null = sin fechas)
  feedVersions: string[];
}

// Item de crtm:line:<routeId>
export interface CRTMLineDoc {
  routeId: string;
  label: string;
  name: string;
  network: CRTMNetwork;
  municipality: string | null;
  url: string | null;
  color?: string | null;
  textColor?: string | null;
  directions: CRTMDirection[];
  services?: CRTMService[]; // omitidos en modo catálogo (noSchedule)
  trips?: CRTMTrip[]; // omitidos en modo catálogo (noSchedule)
  noSchedule?: CRTMNoSchedule; // presente = modo catálogo (feed stale, sin horarios)
}

// Item de crtm:meta (lo escribe el pipeline al final, como commit)
export interface CRTMMeta {
  versions: Partial<
    Record<
      CRTMNetwork,
      {
        itemModified: number | string | null; // ArcGIS: epoch; NAP: nombre del fichero publicado
        zipBytes: number;
        feedVersions: string[];
        skipped?: string; // (histórico) motivo de exclusión de la run
        catalogOnly?: string; // feed en modo catálogo: líneas/paradas sin horarios (motivo + calendario)
      }
    >
  >;
  generatedAt: string;
  counts: Record<string, unknown>;
  shapes?: {
    bucket: string;
    count: number;
    totalBytes: number;
    maxBytes: number;
    maxRouteId: string | null;
  };
}

// Geometría de recorrido: item de R2 line/<routeId>.json (escrito por el pipeline)
export interface CRTMShapeDirection {
  id: number; // 0 | 1 (mismo id que directions del doc de KV)
  headsign: string; // mismo headsign que directions del doc de KV
  shapeId: string; // shape GTFS origen (heurística: trip con más paradas de la dirección)
  distanceM: number; // longitud de la polilínea simplificada
  pointCount: number; // puntos tras simplificar
  geometry: {
    type: 'MultiLineString';
    coordinates: number[][][]; // tramos de [lon, lat] GeoJSON (huecos > 500 m cortan el tramo)
  };
}

export interface CRTMLineRouteDoc {
  routeId: string;
  label: string;
  name: string;
  network: CRTMNetwork;
  municipality: string | null;
  color?: string | null;
  textColor?: string | null;
  toleranceM: number; // tolerancia Douglas-Peucker aplicada (adaptive, empieza en 1.5 m)
  bounds: [number, number, number, number]; // [oeste, sur, este, norte] sobre los puntos simplificados
  directions: CRTMShapeDirection[];
}

/**
 * Item de la respuesta de GET /crtm/stops/arrivals/:stopCode — el contrato que consume el
 * frontend. Unifica las tres ramas que la producen: tablón teórico/overlay GTFS-RT de
 * cercanías (±trainId/platform/delaySec...), refuerzos RT inyectados (added, con
 * dest/dir/scheduledISO/time/dayOffset a null) y board del widget (±network/lineName/vehicle).
 * estimatedISO es el único campo garantizado no nulo: es la clave del orden.
 */
export interface CRTMArrivalItem {
  line: string;
  routeId: string | null;
  network?: string;
  lineName?: string;
  dest: string | null;
  dir: number | null;
  scheduledISO: string | null;
  estimatedISO: string;
  arrivesInMin: number;
  dayOffset: number | null;
  time: string | null;
  realtime: boolean;
  added?: true; // refuerzo SPECIAL/ADDED inyectado: no existe en el GTFS estático cacheado
  canceled?: true; // cancelación del feed RT: permanece visible, la UI decide
  stale?: true; // salida servida por el fallback de calendario caducado
  delaySec?: number;
  platform?: string;
  accessible?: boolean;
  trainId?: string;
  trainStatus?: string;
  trainPosition?: { latitude: number; longitude: number };
  tripId?: string; // trip_id GTFS (docs de cercanías con tid): join con el GTFS-RT de Renfe
  vehicle?: string; // codVehicle del widget (bus/ML/metro)
}
