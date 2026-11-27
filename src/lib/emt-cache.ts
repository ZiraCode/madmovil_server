import type { Env } from '../types';
import type {
  Stop,
  Line,
  LineDetail,
  StopDetail,
  EMTStopsResponse,
  EMTLinesResponse,
  EMTLineDetailResponse,
  EMTStopDetailResponse,
  Calendar,
  EMTCalendarResponse,
  DayType,
  LineTimetable,
  EMTArrivesResponse,
  BusArrival,
  LineRoute,
  EMTLineRouteResponse,
  LineIncident,
  IncidentsFeed,
  EMTIncidentsResponse,
} from '../types/emt-data';
import { EMT_CONFIG } from './config';
import { emtFetch, EMTApiError } from './emt-fetch';
import { getCachedArtifact, getCachedJSON, createArtifactMemo } from './kv-cache';
import { formatDateYYYYMMDD, parseMadridDateTime } from './date-utils';

export class StopNotFoundError extends Error {
  constructor(stopId: string) {
    super(`Parada ${stopId} no disponible actualmente o inexistente`);
    this.name = 'StopNotFoundError';
  }
}

export class LineNotFoundError extends Error {
  constructor(label: string) {
    super(`No existe ruta para la línea ${label}`);
    this.name = 'LineNotFoundError';
  }
}

export async function fetchAndCacheStops(env: Env): Promise<Stop[]> {
  const emtResponse = await emtFetch<EMTStopsResponse>(
    env,
    EMT_CONFIG.ENDPOINTS.STOPS_LIST,
    'POST',
  );

  const stops: Stop[] = emtResponse.data.map((stopData) => ({
    stopId: stopData.node,
    name: stopData.name,
    coordinates: {
      latitude: stopData.geometry.coordinates[1],
      longitude: stopData.geometry.coordinates[0],
    },
    lines: stopData.lines,
  }));

  await env.EMT_CACHE.put(EMT_CONFIG.CACHE_KEYS.STOPS_ALL, JSON.stringify(stops), {
    expirationTtl: EMT_CONFIG.DATA_TTL,
  });

  return stops;
}

export async function fetchAndCacheLines(env: Env): Promise<Line[]> {
  const dateString = formatDateYYYYMMDD(new Date());
  const emtResponse = await emtFetch<EMTLinesResponse>(
    env,
    `${EMT_CONFIG.ENDPOINTS.LINES_INFO}${dateString}/`,
  );

  const lines: Line[] = emtResponse.data.map((lineData) => ({
    lineId: lineData.line,
    label: lineData.label,
    nameA: lineData.nameA,
    nameB: lineData.nameB,
    group: lineData.group,
    color: lineData.color,
  }));

  await env.EMT_CACHE.put(EMT_CONFIG.CACHE_KEYS.LINES_ALL, JSON.stringify(lines), {
    expirationTtl: EMT_CONFIG.DATA_TTL,
  });

  return lines;
}

// stops:all y lines:all son los artefactos multi-MB que /search lee en cada pulsación:
// memos por isolate (single-flight con expulsión del fallo, ver kv-cache.ts)
const stopsMemo = createArtifactMemo<Stop[]>(
  EMT_CONFIG.CACHE_KEYS.STOPS_ALL,
  EMT_CONFIG.ARTIFACTS_MEMO_TTL_MS,
);
const linesMemo = createArtifactMemo<Line[]>(
  EMT_CONFIG.CACHE_KEYS.LINES_ALL,
  EMT_CONFIG.ARTIFACTS_MEMO_TTL_MS,
);

/**
 * stops:all ocupa varios MB y /search lo lee en cada pulsación del buscador; el contenido
 * solo cambia con el TTL de 7 días (mismo patrón que los artefactos CRTM)
 */
export function getCachedStops(env: Env): Promise<Stop[]> {
  return getCachedArtifact(env, stopsMemo, fetchAndCacheStops);
}

export function getCachedLines(env: Env): Promise<Line[]> {
  return getCachedArtifact(env, linesMemo, fetchAndCacheLines);
}

export async function fetchAndCacheLineDetail(
  env: Env,
  lineId: string,
  dateString?: string,
): Promise<LineDetail> {
  const finalDateString = dateString || formatDateYYYYMMDD(new Date());
  // La línea se valida contra el listado oficial ANTES de llamar a EMT (mismo criterio que
  // fetchAndCacheStopDetail): id no listado → 404 sin gastar cuota ni escrituras KV.
  // La API EMT resuelve por label y por lineId interno ('001' → 361): se aceptan los dos.
  try {
    const lines = await getCachedLines(env);
    if (!lines.some((l) => l.lineId === lineId || l.label === lineId)) {
      throw new LineNotFoundError(lineId);
    }
  } catch (error) {
    if (error instanceof LineNotFoundError) throw error;
    // listado inaccesible: fail-open al comportamiento previo
  }
  const emtResponse = await emtFetch<EMTLineDetailResponse>(
    env,
    `${EMT_CONFIG.ENDPOINTS.LINE_DETAIL}${lineId}/info/${finalDateString}/`,
  );

  if (!emtResponse.data || emtResponse.data.length === 0) {
    throw new LineNotFoundError(lineId);
  }

  const lineData = emtResponse.data[0];
  const lineDetail: LineDetail = {
    lineId: lineData.line,
    label: lineData.label,
    nameA: lineData.nameA,
    nameB: lineData.nameB,
    dateRef: lineData.dateRef,
    timeTable: lineData.timeTable,
  };

  const cacheKey = `${EMT_CONFIG.CACHE_KEYS.LINE_DETAIL}${lineId}:${finalDateString}`;
  await env.EMT_CACHE.put(cacheKey, JSON.stringify(lineDetail), {
    expirationTtl: EMT_CONFIG.DATA_TTL,
  });

  return lineDetail;
}

export function getCachedLineDetail(
  env: Env,
  lineId: string,
  dateString?: string,
): Promise<LineDetail> {
  const finalDateString = dateString || formatDateYYYYMMDD(new Date());
  const cacheKey = `${EMT_CONFIG.CACHE_KEYS.LINE_DETAIL}${lineId}:${finalDateString}`;
  return getCachedJSON(env, cacheKey, (e) => fetchAndCacheLineDetail(e, lineId, finalDateString));
}

export class EMTServiceUnavailableError extends Error {
  constructor(stopId: string) {
    super(
      `La EMT no ha podido servir el detalle de la parada ${stopId}; inténtalo de nuevo en unos instantes`,
    );
    this.name = 'EMTServiceUnavailableError';
  }
}

export async function fetchAndCacheStopDetail(env: Env, stopId: string): Promise<StopDetail> {
  // Comprobar contra el listado oficial ANTES de llamar a EMT: un stopId no listado no
  // merece fetch ni escritura KV (evita enumeración de claves stop:detail:* con cuota EMT)
  try {
    const stops = await getCachedStops(env);
    if (!stops.some((s) => s.stopId === stopId)) {
      throw new StopNotFoundError(stopId);
    }
  } catch (error) {
    if (error instanceof StopNotFoundError) {
      throw error;
    }
    // listado inaccesible: mantener el comportamiento previo (fetch directo a EMT)
  }

  let emtResponse: EMTStopDetailResponse;
  try {
    emtResponse = await emtFetch<EMTStopDetailResponse>(
      env,
      `${EMT_CONFIG.ENDPOINTS.STOP_DETAIL}${stopId}/detail/`,
    );
  } catch (error) {
    if (error instanceof EMTApiError && error.emtCode === '90') {
      // code 90 es ambiguo: parada inexistente o microcaída del servicio de detail de la EMT.
      // Si la parada figura en el listado oficial (stops:all), es la EMT la que falla → 503, no 404.
      // Si el listado no está accesible, no podemos distinguir → 404 (como antes).
      let inOfficialList = false;
      try {
        const stops = await getCachedStops(env);
        inOfficialList = stops.some((s) => s.stopId === stopId);
      } catch {
        // listado inaccesible: mantener comportamiento previo
      }
      if (inOfficialList) {
        throw new EMTServiceUnavailableError(stopId);
      }
      throw new StopNotFoundError(stopId);
    }
    throw error;
  }

  if (
    !emtResponse.data ||
    emtResponse.data.length === 0 ||
    !emtResponse.data[0].stops ||
    emtResponse.data[0].stops.length === 0
  ) {
    throw new StopNotFoundError(stopId);
  }

  const stopData = emtResponse.data[0].stops[0];
  const stopDetail: StopDetail = {
    stopId: stopData.stop,
    name: stopData.name,
    postalAddress: stopData.postalAddress,
    coordinates: {
      latitude: stopData.geometry.coordinates[1],
      longitude: stopData.geometry.coordinates[0],
    },
    pmv: stopData.pmv,
    lines: stopData.dataLine,
  };

  const cacheKey = `${EMT_CONFIG.CACHE_KEYS.STOP_DETAIL}${stopId}`;
  await env.EMT_CACHE.put(cacheKey, JSON.stringify(stopDetail), {
    expirationTtl: EMT_CONFIG.DATA_TTL,
  });

  return stopDetail;
}

export function getCachedStopDetail(env: Env, stopId: string): Promise<StopDetail> {
  return getCachedJSON(env, `${EMT_CONFIG.CACHE_KEYS.STOP_DETAIL}${stopId}`, (e) =>
    fetchAndCacheStopDetail(e, stopId),
  );
}

export async function refreshAllCache(
  env: Env,
  year?: number,
): Promise<{ stops: number; lines: number; calendar?: number }> {
  const currentYear = year || new Date().getFullYear();

  const [stops, lines, calendar] = await Promise.all([
    fetchAndCacheStops(env),
    fetchAndCacheLines(env),
    fetchAndCacheCalendar(env, currentYear),
  ]);

  return {
    stops: stops.length,
    lines: lines.length,
    calendar: Object.keys(calendar).length,
  };
}

/**
 * Obtiene y cachea el calendario de la EMT para un año específico
 * @param env Environment con bindings de KV
 * @param year Año del calendario (ej: 2025)
 * @returns Calendario con Record<fecha, tipo de día>
 */
export async function fetchAndCacheCalendar(env: Env, year: number): Promise<Calendar> {
  const emtResponse = await emtFetch<EMTCalendarResponse>(
    env,
    `${EMT_CONFIG.ENDPOINTS.CALENDAR}${year}0101/${year}1231/`,
  );

  const calendar: Calendar = {};
  for (const day of emtResponse.data) {
    let dayType: DayType;
    switch (day.dayType) {
      case 'LA':
        dayType = 'laboral';
        break;
      case 'SA':
        dayType = 'sabado';
        break;
      case 'FE':
        dayType = 'festivo';
        break;
      default:
        console.warn(`Unknown day type: ${day.dayType}, defaulting to laboral`);
        dayType = 'laboral';
    }
    calendar[day.dayDate] = dayType;
  }

  const cacheKey = `${EMT_CONFIG.CACHE_KEYS.CALENDAR}${year}`;
  await env.EMT_CACHE.put(cacheKey, JSON.stringify(calendar), {
    expirationTtl: EMT_CONFIG.CALENDAR_TTL,
  });

  return calendar;
}

/**
 * Obtiene y cachea los horarios de una línea (deriva del line detail: no existe endpoint v2 de timetable)
 * @param env Environment con bindings de KV
 * @param lineId ID de la línea
 * @returns Horarios de la línea organizados por tipo de día
 */
export async function fetchAndCacheLineTimetable(env: Env, lineId: string): Promise<LineTimetable> {
  const lineDetail = await getCachedLineDetail(env, lineId);

  const lineTimetable: LineTimetable = {
    lineId: lineDetail.lineId,
    schedules: {},
  };

  for (const timeTableEntry of lineDetail.timeTable) {
    const directionInfo = [timeTableEntry.Direction1, timeTableEntry.Direction2];

    switch (timeTableEntry.idDayType) {
      case 'LA':
        lineTimetable.schedules.laboral = directionInfo;
        break;
      case 'SA':
        lineTimetable.schedules.sabado = directionInfo;
        break;
      case 'FE':
        lineTimetable.schedules.festivo = directionInfo;
        break;
      default:
        console.warn(`Unknown day type in timetable: ${timeTableEntry.idDayType}`);
    }
  }

  const cacheKey = `${EMT_CONFIG.CACHE_KEYS.LINE_TIMETABLE}${lineId}`;
  await env.EMT_CACHE.put(cacheKey, JSON.stringify(lineTimetable), {
    expirationTtl: EMT_CONFIG.TIMETABLE_TTL,
  });

  return lineTimetable;
}

/**
 * Obtiene los horarios de una línea cacheados o los descarga si no existen
 * @param env Environment con bindings de KV
 * @param lineId ID de la línea
 * @returns Horarios de la línea organizados por tipo de día
 */
export function getCachedLineTimetable(env: Env, lineId: string): Promise<LineTimetable> {
  return getCachedJSON(env, `${EMT_CONFIG.CACHE_KEYS.LINE_TIMETABLE}${lineId}`, (e) =>
    fetchAndCacheLineTimetable(e, lineId),
  );
}

// Micro-caché por isolate Y por binding KV (como stopsMemo/linesMemo: los tests con mockKV
// fresco no comparten estimaciones) y con techo de entradas: una por stopId:line consultado
// crecería sin límite en un isolate de vida larga
interface ArrivalsEntry {
  fetchedAt: number;
  arrivals: BusArrival[];
}

const arrivalsCaches = new WeakMap<object, Map<string, ArrivalsEntry>>();

function arrivalsCacheFor(env: Env): Map<string, ArrivalsEntry> {
  let cache = arrivalsCaches.get(env.EMT_CACHE);
  if (!cache) {
    cache = new Map();
    arrivalsCaches.set(env.EMT_CACHE, cache);
  }
  return cache;
}

// purga (expiradas primero, luego la más antigua) tras cada set — patrón de pruneStopTimesCache
function pruneArrivalsCache(cache: Map<string, ArrivalsEntry>): void {
  if (cache.size <= EMT_CONFIG.ARRIVALS_CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.fetchedAt >= EMT_CONFIG.ARRIVALS_CACHE_TTL * 1000) cache.delete(key);
  }
  while (cache.size > EMT_CONFIG.ARRIVALS_CACHE_MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [key, entry] of cache) {
      if (entry.fetchedAt < oldest) {
        oldest = entry.fetchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    cache.delete(oldestKey);
  }
}

/**
 * Obtiene los próximos autobuses de una parada (tiempo real, sin caché KV)
 * Micro-caché en memoria por isolate y binding con TTL corto y techo de entradas para
 * proteger la API EMT de ráfagas del frontend.
 * Si la EMT falla o tarda más de ARRIVALS_FETCH_TIMEOUT_MS, sirve la última estimación disponible
 * mientras no supere ARRIVALS_STALE_MAX_AGE_MS (la EMT sufre degradaciones de minutos en arrives)
 * @param env Environment con bindings
 * @param stopId ID de la parada
 * @param line Línea concreta (opcional; sin ella la API devuelve todas las líneas de la parada)
 * @returns Estimaciones ordenadas por tiempo de llegada
 */
export async function getArrivals(env: Env, stopId: string, line?: string): Promise<BusArrival[]> {
  const cache = arrivalsCacheFor(env);
  const cacheKey = `${stopId}:${line ?? 'all'}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt < EMT_CONFIG.ARRIVALS_CACHE_TTL * 1000) {
    return cached.arrivals;
  }

  const lineSegment = line ? `${line}/` : '';
  let emtResponse: EMTArrivesResponse;
  try {
    emtResponse = await emtFetch<EMTArrivesResponse>(
      env,
      `${EMT_CONFIG.ENDPOINTS.STOP_ARRIVES}${stopId}/arrives/${lineSegment}`,
      'POST',
      {
        cultureInfo: 'ES',
        Text_StopRequired_YN: 'N',
        Text_EstimationsRequired_YN: 'Y',
        Text_IncidencesRequired_YN: 'N',
        DateTime_Referenced_Incidencies_YYYYMMDD: formatDateYYYYMMDD(new Date()),
      },
      AbortSignal.timeout(EMT_CONFIG.ARRIVALS_FETCH_TIMEOUT_MS),
    );
  } catch (error) {
    if (error instanceof EMTApiError && error.emtCode === '80') {
      throw new StopNotFoundError(stopId);
    }
    if (cached && Date.now() - cached.fetchedAt < EMT_CONFIG.ARRIVALS_STALE_MAX_AGE_MS) {
      console.warn(
        `EMT arrives falló para ${cacheKey}; sirviendo última estimación (${Math.round((Date.now() - cached.fetchedAt) / 1000)}s antigua)`,
      );
      return cached.arrivals;
    }
    throw error;
  }

  const arriveList = emtResponse.data?.[0]?.Arrive ?? [];
  const arrivals: BusArrival[] = arriveList
    .map((arrive) => ({
      line: arrive.line,
      destination: arrive.destination,
      estimateArriveSec: arrive.estimateArrive,
      arrivesInMin: arrive.estimateArrive >= 999999 ? null : Math.floor(arrive.estimateArrive / 60),
      distanceM: arrive.DistanceBus,
      busId: arrive.bus ?? null,
      busPosition: arrive.geometry?.coordinates
        ? { latitude: arrive.geometry.coordinates[1], longitude: arrive.geometry.coordinates[0] }
        : null,
    }))
    .sort((a, b) => a.estimateArriveSec - b.estimateArriveSec);

  cache.set(cacheKey, {
    fetchedAt: Date.now(),
    arrivals,
  });
  pruneArrivalsCache(cache);

  return arrivals;
}

/**
 * Obtiene y cachea la ruta (geometría GeoJSON) de una línea
 * @param env Environment con bindings de KV
 * @param label Label público de la línea (número de línea)
 * @returns Ruta con itinerario y paradas por dirección
 */
export async function fetchAndCacheLineRoute(env: Env, label: string): Promise<LineRoute> {
  const emtResponse = await emtFetch<EMTLineRouteResponse>(
    env,
    `${EMT_CONFIG.ENDPOINTS.LINE_ROUTE}${label}/route/`,
  );

  if (!emtResponse.data?.itinerary) {
    throw new LineNotFoundError(label);
  }

  const d = emtResponse.data;
  const lineRoute: LineRoute = {
    label: d.label,
    lineId: d.line,
    nameA: d.nameSectionA,
    nameB: d.nameSectionB,
    itinerary: d.itinerary,
    stops: d.stops,
  };

  const cacheKey = `${EMT_CONFIG.CACHE_KEYS.LINE_ROUTE}${label}`;
  await env.EMT_CACHE.put(cacheKey, JSON.stringify(lineRoute), {
    expirationTtl: EMT_CONFIG.DATA_TTL,
  });

  return lineRoute;
}

/**
 * Obtiene la ruta de una línea cacheada o la descarga si no existe
 * @param env Environment con bindings de KV
 * @param label Label público de la línea (número de línea)
 * @returns Ruta con itinerario y paradas por dirección
 */
export function getCachedLineRoute(env: Env, label: string): Promise<LineRoute> {
  return getCachedJSON(env, `${EMT_CONFIG.CACHE_KEYS.LINE_ROUTE}${label}`, (e) =>
    fetchAndCacheLineRoute(e, label),
  );
}

/**
 * Obtiene y cachea el feed completo de incidencias (un solo ítem de caché sirve a todas las líneas)
 * Se consulta siempre con lineid=all y se filtra localmente: la query por línea de la EMT es
 * inconsistente (devuelve menos items que los vigentes con esa categoría, verificado 2026-08-17)
 * @param env Environment con bindings de KV
 * @returns Feed normalizado con todas las incidencias publicadas (activas y caducadas)
 */
export async function fetchAndCacheIncidents(env: Env): Promise<IncidentsFeed> {
  const emtResponse = await emtFetch<EMTIncidentsResponse>(
    env,
    `${EMT_CONFIG.ENDPOINTS.LINE_INCIDENTS}all/`,
  );

  const feed = emtResponse.data?.[0];
  const items = feed?.item ?? [];

  const incidents: LineIncident[] = items.map((item) => {
    const startsAt = parseMadridDateTime(item.rssAfectaDesde);
    const endsAt = parseMadridDateTime(item.rssAfectaHasta);
    const publishedAt = item.pubDate ? new Date(item.pubDate) : null;

    return {
      id: item.guid,
      title: item.title,
      description: item.description,
      lines: Array.isArray(item.category) ? item.category : [item.category],
      cause: item.GoogleTransitCause ?? null,
      effect: item.GoogleTransitEffect ?? null,
      startsAt: startsAt ? startsAt.toISOString() : null,
      endsAt: endsAt ? endsAt.toISOString() : null,
      publishedAt:
        publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt.toISOString() : null,
      documentUrl: item.enclosure?.['@url'] ?? item.link ?? null,
    };
  });

  const incidentsFeed: IncidentsFeed = {
    lastBuildDate: feed?.lastBuildDate ?? null,
    incidents,
  };

  await env.EMT_CACHE.put(EMT_CONFIG.CACHE_KEYS.INCIDENTS_ALL, JSON.stringify(incidentsFeed), {
    expirationTtl: EMT_CONFIG.INCIDENTS_TTL,
  });

  return incidentsFeed;
}

/**
 * Obtiene el feed de incidencias cacheado o lo descarga si no existe
 * @param env Environment con bindings de KV
 * @returns Feed normalizado con todas las incidencias publicadas
 */
export function getCachedIncidents(env: Env): Promise<IncidentsFeed> {
  return getCachedJSON(env, EMT_CONFIG.CACHE_KEYS.INCIDENTS_ALL, fetchAndCacheIncidents);
}

/**
 * Incidencias vigentes (hasta >= ahora o sin fecha de fin) para una línea, o de todas si label === 'all'
 * El feed arrastra avisos caducados que siguen publicados (rssfinaldate ~30 días): se filtran aquí
 * Orden: por inicio de afectación ascendente, sin fecha al final
 * @param env Environment con bindings de KV
 * @param label Label público de la línea (ej: 5, N13, M1) o 'all'
 * @returns Feed filtrado con las incidencias relevantes
 */
export async function getLineIncidents(env: Env, label: string): Promise<IncidentsFeed> {
  const feed = await getCachedIncidents(env);
  const now = Date.now();

  const incidents = feed.incidents
    .filter((incident) => {
      if (incident.endsAt !== null && Date.parse(incident.endsAt) < now) {
        return false;
      }
      return label === 'all' || incident.lines.includes(label);
    })
    .sort((a, b) => {
      if (a.startsAt === null && b.startsAt === null) return 0;
      if (a.startsAt === null) return 1;
      if (b.startsAt === null) return -1;
      return Date.parse(a.startsAt) - Date.parse(b.startsAt);
    });

  return {
    lastBuildDate: feed.lastBuildDate,
    incidents,
  };
}
