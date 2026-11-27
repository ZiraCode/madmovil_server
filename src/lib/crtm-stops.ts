import type { CRTMStop, CRTMLineDoc } from '../types/crtm-data';
import { formatYmd } from './date-utils';

// Los índices cuelgan del propio array memoizado del artefacto (WeakMap por identidad, mismo
// patrón que search-index.ts): viven lo que viva el valor de stopsMemo de crtm-cache y no
// pueden desincronizarse de él — una recarga del artefacto es un array nuevo (JSON.parse)
// y con él se reconstruye el índice. Sin env ni TTL propio.
const nameIndexMemo = new WeakMap<CRTMStop[], Map<string, string>>();
const fullIndexMemo = new WeakMap<CRTMStop[], Map<string, CRTMStop>>();

/**
 * Índice code → nombre de parada (schedule/arrivals/timetable resuelven cabeceras por código)
 */
export function stopNameIndex(stops: CRTMStop[]): Map<string, string> {
  let index = nameIndexMemo.get(stops);
  if (index) return index;
  index = new Map(stops.map((s) => [s.code, s.name]));
  nameIndexMemo.set(stops, index);
  return index;
}

/**
 * Índice code → parada completa (detail enriquece las direcciones con nombre/coords)
 */
export function stopIndex(stops: CRTMStop[]): Map<string, CRTMStop> {
  let index = fullIndexMemo.get(stops);
  if (index) return index;
  index = new Map(stops.map((s) => [s.code, s]));
  fullIndexMemo.set(stops, index);
  return index;
}

/** Resumen de las redes en modo catálogo (feed stale) que sirven una parada */
export interface NoScheduleSummary {
  networks: string[];
  calendarEnd: string | null;
  feedVersions: string[];
}

/**
 * noScheduleData de una parada: redes sin horarios oficiales (docs con noSchedule cuyas
 * direcciones incluyen el código, respetando ?line= para no contaminar el aviso con líneas
 * ajenas al filtro). Null = ninguna línea de la parada está en catálogo.
 */
export function noScheduleSummary(
  docs: CRTMLineDoc[],
  stopCode: string,
  lineQuery: string | null = null,
): NoScheduleSummary | null {
  const noScheduleDocs = docs.filter(
    (d) =>
      d.noSchedule &&
      (!lineQuery || d.label === lineQuery) &&
      d.directions.some((dir) => dir.stops.includes(stopCode)),
  );
  if (noScheduleDocs.length === 0) {
    return null;
  }
  return {
    networks: [...new Set(noScheduleDocs.map((d) => d.network))],
    calendarEnd: noScheduleDocs.reduce<string | null>((acc, d) => {
      const end = d.noSchedule?.calendarEnd ?? null;
      return end !== null && (acc === null || end > acc) ? end : acc;
    }, null),
    feedVersions: [...new Set(noScheduleDocs.flatMap((d) => d.noSchedule?.feedVersions ?? []))],
  };
}

/**
 * Mensaje de feed caducado de las respuestas con noScheduleData (schedule + arrivals)
 */
export function noScheduleMessage(summary: NoScheduleSummary): string {
  return `Sin horarios disponibles: el feed GTFS de esta red está caducado${summary.calendarEnd ? ` (calendario publicado hasta ${formatYmd(summary.calendarEnd)})` : ''}`;
}
