import type { Env } from '../types';
import type { CRTMNetwork } from '../types/crtm-data';
import { CRTM_CONFIG } from './config';
import { asArray } from './text-utils';

// API no documentada del widget oficial del CRTM (www.crtm.es/widgets/): tablón de próximas
// llegadas por parada con estimaciones del SAE. Es la fuente que polled el widget público y
// la que usan el resto de aplicaciones (decisión 2026-10-09 tras el silencio del CRTM al
// email de opendata: sin contrato ni licencia → todo fallo degrada a tablón teórico).
//
// GetStopsTimes.php?codStop=<mode>_<code>&type=1&orderBy=2&stopTimesByIti=3 devuelve
// stopTimes = { actualDate (reloj del backend), stop, times.Time[], linesStatus.LineStatus[] }.
// El codLine ('8__224___', '4__1___') ES el routeId de nuestros artefactos GTFS y los
// codStops de metro/ML ('4_12', '10_5') son nuestros códigos públicos. En bus, el prefijo
// de modo del poste NO se deriva de la red de sus líneas (la 20789 es 9__6__005_ y vive
// como 8_20789) → resolveWidgetStopCodes lo resuelve con GetStops.php y lo cachea en KV.
//
// Quirks del backend SOAP→JSON verificados en vivo (2026-10-09): colecciones de 1 elemento
// como objeto suelto (times.Time de 10_5), colecciones vacías como {} (también la raíz:
// parada inexistente y parada sin servicio son indistinguibles), HTTP 200 siempre y errores
// con {"error": ...}. direction del widget = direction_id GTFS + 1 (1/2 → 0/1).

interface RawWidgetLine {
  codLine?: string;
  shortDescription?: string;
  description?: string;
  codMode?: string;
}

interface RawWidgetTime {
  line?: RawWidgetLine;
  direction?: number;
  destination?: string;
  destinationStop?: { name?: string };
  time?: string;
  codVehicle?: string;
}

interface RawWidgetLineStatus {
  line?: { codLine?: string };
  SAEStatus?: boolean;
}

interface RawWidgetStopTimes {
  actualDate?: string;
  stop?: { name?: string };
  times?: { Time?: unknown };
  linesStatus?: { LineStatus?: unknown };
}

export interface WidgetArrival {
  routeId: string; // codLine = routeId GTFS exacto
  line: string; // label (shortDescription)
  lineName: string | null; // description completa del itinerario
  network: CRTMNetwork | null; // por prefijo del routeId
  dest: string | null; // destinationStop.name (la terminal hacia la que va)
  dir: number | null; // GTFS 0|1 (direction del widget - 1)
  timeMs: number; // instante estimado de llegada
  vehicle: string | null;
  realtime: boolean; // SAEStatus de su línea (false = hora teórica)
}

export interface WidgetStopTimes {
  widgetStopCode: string;
  stopName: string | null;
  actualDateMs: number | null; // reloj del backend (referencia para arrivesInMin)
  arrivals: WidgetArrival[];
  fetchedAtMs: number;
}

function networkForCodLine(codLine: string): CRTMNetwork | null {
  if (codLine.startsWith('8__')) return 'interurban';
  if (codLine.startsWith('9__')) return 'urban';
  if (codLine.startsWith('10_')) return 'ml';
  if (codLine.startsWith('4__')) return 'metro';
  return null;
}

/** direction del widget (1/2) → direction_id GTFS (0/1); valores imprevistos → null */
function normalizeDirection(direction: unknown): number | null {
  if (direction === 1) return 0;
  if (direction === 2) return 1;
  return null;
}

function parseWidgetStopTimes(raw: unknown, widgetStopCode: string): WidgetStopTimes | null {
  if (raw === null || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  if (body.error) return null;

  const stopTimes = body.stopTimes as RawWidgetStopTimes | undefined;
  if (!stopTimes || typeof stopTimes !== 'object') {
    // {} en la raíz = parada sin servicio ahora (o inexistente, ya validada contra stops:all)
    return {
      widgetStopCode,
      stopName: null,
      actualDateMs: null,
      arrivals: [],
      fetchedAtMs: Date.now(),
    };
  }

  const actualDate =
    typeof stopTimes.actualDate === 'string' ? Date.parse(stopTimes.actualDate) : null;
  const saeByCodLine = new Map<string, boolean>();
  for (const item of asArray(stopTimes.linesStatus?.LineStatus)) {
    const status = item as RawWidgetLineStatus;
    const codLine = status?.line?.codLine;
    if (codLine) saeByCodLine.set(codLine, status.SAEStatus === true);
  }

  const arrivals: WidgetArrival[] = [];
  for (const item of asArray(stopTimes.times?.Time)) {
    const time = item as RawWidgetTime;
    const routeId = time?.line?.codLine;
    if (!routeId) continue;
    const timeMs = typeof time.time === 'string' ? Date.parse(time.time) : NaN;
    if (!Number.isFinite(timeMs)) continue;
    arrivals.push({
      routeId,
      line: time.line?.shortDescription || routeId,
      lineName: time.line?.description || null,
      network: networkForCodLine(routeId),
      dest: time.destinationStop?.name || time.destination || null,
      dir: normalizeDirection(time.direction),
      timeMs,
      vehicle: time.codVehicle || null,
      // sin entrada de linesStatus no hay razón para desconfiar del dato (línea sin SAE declarado)
      realtime: saeByCodLine.get(routeId) !== false,
    });
  }
  arrivals.sort((a, b) => a.timeMs - b.timeMs);

  return {
    widgetStopCode,
    stopName: typeof stopTimes.stop?.name === 'string' ? stopTimes.stop.name : null,
    actualDateMs: actualDate !== null && Number.isFinite(actualDate) ? actualDate : null,
    arrivals,
    fetchedAtMs: Date.now(),
  };
}

// Caché por isolate + single-flight: 1 fetch por parada como máximo cada CACHE_TTL_MS
interface StopTimesCacheEntry {
  snapshot: WidgetStopTimes;
  fetchedAtMs: number;
}

const stopTimesCache = new Map<string, StopTimesCacheEntry>();
const stopTimesInflight = new Map<string, Promise<WidgetStopTimes | null>>();
// Caché negativa: un fallo se recuerda durante CACHE_TTL_MS para no pagar el timeout de
// fetch en cada petición mientras el widget está caído (el single-flight solo colapsa las
// concurrentes, no las secuenciales)
const stopTimesFailures = new Map<string, number>();

function widgetStopTimesUrl(widgetStopCode: string): string {
  return `${CRTM_CONFIG.WIDGET.BASE_URL}${CRTM_CONFIG.WIDGET.GET_STOP_TIMES}?codStop=${encodeURIComponent(widgetStopCode)}&${CRTM_CONFIG.WIDGET.STOP_TIMES_PARAMS}`;
}

// purga FIFO compartida: expiradas primero (por TTL), luego la más antigua (techo de entradas)
function pruneFifo<T>(map: Map<string, T>, ageOf: (value: T) => number): void {
  if (map.size <= CRTM_CONFIG.WIDGET.CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, value] of map) {
    if (now - ageOf(value) >= CRTM_CONFIG.WIDGET.CACHE_TTL_MS) map.delete(key);
  }
  while (map.size > CRTM_CONFIG.WIDGET.CACHE_MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [key, value] of map) {
      if (ageOf(value) < oldest) {
        oldest = ageOf(value);
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    map.delete(oldestKey);
  }
}

function pruneStopTimesCache(): void {
  pruneFifo(stopTimesCache, (entry) => entry.fetchedAtMs);
  pruneFifo(stopTimesFailures, (failedAt) => failedAt);
}

async function fetchWidgetStopTimes(widgetStopCode: string): Promise<WidgetStopTimes | null> {
  try {
    const res = await fetch(widgetStopTimesUrl(widgetStopCode), {
      headers: { 'User-Agent': CRTM_CONFIG.WIDGET.USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(CRTM_CONFIG.WIDGET.FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseWidgetStopTimes(await res.json(), widgetStopCode);
    if (parsed === null) console.warn(`Widget CRTM ${widgetStopCode}: respuesta con error`);
    return parsed;
  } catch (error) {
    console.warn(
      `Widget CRTM ${widgetStopCode} no disponible: ${error instanceof Error ? error.message : error}`,
    );
    // stale-serve: fallo tras caducar el TTL → última instantánea hasta STALE_MAX_AGE_MS
    const cached = stopTimesCache.get(widgetStopCode);
    if (cached && Date.now() - cached.fetchedAtMs < CRTM_CONFIG.WIDGET.STALE_MAX_AGE_MS) {
      return cached.snapshot;
    }
    return null;
  }
}

/**
 * Tablón del widget para un codStop (<mode>_<code>), cacheado por isolate.
 * null = widget no disponible (el llamador sirve el tablón teórico con realtime.available false)
 */
export async function getWidgetStopTimes(widgetStopCode: string): Promise<WidgetStopTimes | null> {
  const cached = stopTimesCache.get(widgetStopCode);
  if (cached && Date.now() - cached.fetchedAtMs < CRTM_CONFIG.WIDGET.CACHE_TTL_MS) {
    return cached.snapshot;
  }
  const failedAt = stopTimesFailures.get(widgetStopCode);
  if (failedAt !== undefined && Date.now() - failedAt < CRTM_CONFIG.WIDGET.CACHE_TTL_MS) {
    return null;
  }
  let inflight = stopTimesInflight.get(widgetStopCode);
  if (!inflight) {
    inflight = fetchWidgetStopTimes(widgetStopCode)
      .then((snapshot) => {
        if (snapshot) {
          stopTimesFailures.delete(widgetStopCode);
          stopTimesCache.set(widgetStopCode, { snapshot, fetchedAtMs: snapshot.fetchedAtMs });
        } else {
          stopTimesFailures.set(widgetStopCode, Date.now());
        }
        pruneStopTimesCache();
        return snapshot;
      })
      .finally(() => {
        stopTimesInflight.delete(widgetStopCode);
      });
    stopTimesInflight.set(widgetStopCode, inflight);
  }
  return inflight;
}

export function isWidgetStopTimesFresh(snapshot: WidgetStopTimes): boolean {
  // Frescura por NUESTRO fetch OK (fiable); actualDate queda como límite holgado contra
  // fuentes congeladas (mismo criterio anti-bandazos que isRealtimeFresh de Renfe)
  if (Date.now() - snapshot.fetchedAtMs >= CRTM_CONFIG.WIDGET.STALE_MAX_AGE_MS) return false;
  if (snapshot.actualDateMs === null) return true;
  return Date.now() - snapshot.actualDateMs < CRTM_CONFIG.WIDGET.ACTUAL_DATE_MAX_AGE_MS;
}

// Resolución del modo de bus: memo por isolate + caché KV del mapeo (el modo de un poste
// no cambia; se escribe una sola vez por parada consultada)
interface ResolveMemoEntry {
  codStops: string[];
  expiresAt: number;
}

const resolveMemo = new WeakMap<object, Map<string, ResolveMemoEntry>>();

async function widgetStopExists(codStop: string): Promise<boolean> {
  const url = `${CRTM_CONFIG.WIDGET.BASE_URL}${CRTM_CONFIG.WIDGET.GET_STOP}?codStop=${encodeURIComponent(codStop)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': CRTM_CONFIG.WIDGET.USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(CRTM_CONFIG.WIDGET.FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (body.error) return false;
  return asArray((body.stops as Record<string, unknown> | undefined)?.Stop).length > 0;
}

/**
 * Códigos de parada del widget que corresponden a nuestro stopCode público:
 * metro/ML → identidad (4_263, 10_5); bus → el poste vive como 8_ o 9_ (verificado: la
 * 20789, línea urbana 9__6__005_, es 8_20789 en el widget) → se resuelve con GetStops.php
 * en paralelo y se cachea. [] = no resuelto (deriva entre feeds o fallo transitorio).
 */
export async function resolveWidgetStopCodes(env: Env, stopCode: string): Promise<string[]> {
  if (/^(4|10)_\d{1,6}$/.test(stopCode)) return [stopCode];
  if (!/^\d{1,10}$/.test(stopCode)) return [];

  const binding = env.EMT_CACHE as unknown as object;
  let memo = resolveMemo.get(binding);
  if (!memo) {
    memo = new Map();
    resolveMemo.set(binding, memo);
  }
  const memoized = memo.get(stopCode);
  if (memoized && memoized.expiresAt > Date.now()) return memoized.codStops;

  const key = `${CRTM_CONFIG.WIDGET.STOP_CODE_CACHE_PREFIX}${stopCode}`;
  const cachedRaw = await env.EMT_CACHE.get(key);
  if (cachedRaw !== null) {
    try {
      const parsed = JSON.parse(cachedRaw) as { codStops?: unknown };
      const codStops = Array.isArray(parsed.codStops)
        ? parsed.codStops.filter((code): code is string => typeof code === 'string')
        : [];
      memo.set(stopCode, {
        codStops,
        expiresAt: Date.now() + CRTM_CONFIG.WIDGET.RESOLVE_MEMO_TTL_MS,
      });
      return codStops;
    } catch {
      // valor corrupto: re-resolver
    }
  }

  const [interurban, urban] = await Promise.allSettled([
    widgetStopExists(`8_${stopCode}`),
    widgetStopExists(`9_${stopCode}`),
  ]);
  const codStops: string[] = [];
  if (interurban.status === 'fulfilled' && interurban.value) codStops.push(`8_${stopCode}`);
  if (urban.status === 'fulfilled' && urban.value) codStops.push(`9_${stopCode}`);

  // fallo transitorio (red/timeouts) sin resolución: no cachear "none" durante 24 h
  const anyRejected = interurban.status === 'rejected' || urban.status === 'rejected';
  if (anyRejected && codStops.length === 0) {
    console.warn('Widget CRTM GetStops no disponible: resolución de modo no cacheada');
    memo.set(stopCode, { codStops: [], expiresAt: Date.now() + 60_000 });
    return [];
  }

  try {
    await env.EMT_CACHE.put(key, JSON.stringify({ codStops }), {
      expirationTtl:
        codStops.length > 0
          ? CRTM_CONFIG.WIDGET.STOP_CODE_TTL
          : CRTM_CONFIG.WIDGET.STOP_CODE_NONE_TTL,
    });
  } catch (error) {
    console.warn(
      `Widget CRTM: no se pudo cachear el modo de ${stopCode}: ${error instanceof Error ? error.message : error}`,
    );
  }
  memo.set(stopCode, { codStops, expiresAt: Date.now() + CRTM_CONFIG.WIDGET.RESOLVE_MEMO_TTL_MS });
  return codStops;
}

// Limpieza para tests
export function __resetWidgetCache(): void {
  stopTimesCache.clear();
  stopTimesInflight.clear();
  stopTimesFailures.clear();
}
