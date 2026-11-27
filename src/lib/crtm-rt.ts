import { CRTM_CONFIG } from './config';

// GTFS-RT oficial de Renfe (data.renfe.com, CC BY 4.0, refresco ~20 s): feeds NACIONALES
// en JSON (mapping camelCase del protobuf). Se filtran a Madrid (núcleo 10) por tripId:
// '10' + día de la ventana móvil + letra de día + trenId + línea (p. ej. 1041L19789C5)
// y refuerzos SPECIAL_10_* — el mismo trip_id que el GTFS estático del NAP ya guardado
// como tid en los docs de cercanías (join exacto).

interface RawTripUpdateEntity {
  id?: string;
  tripUpdate?: {
    trip?: { tripId?: string; scheduleRelationship?: string };
    stopTimeUpdate?: {
      stopId?: string;
      arrival?: { delay?: number; time?: string };
      departure?: { delay?: number; time?: string };
    }[];
    delay?: number;
    vehicle?: { wheelchairAccessible?: string };
  };
}

interface RawVehiclePositionEntity {
  vehicle?: {
    trip?: { tripId?: string };
    position?: { latitude?: number; longitude?: number };
    currentStatus?: string;
    timestamp?: string;
    stopId?: string;
    vehicle?: { id?: string; label?: string };
  };
}

export interface RenfeTripRT {
  tripId: string;
  scheduleRelationship: 'SCHEDULED' | 'CANCELED' | 'ADDED' | 'UNKNOWN';
  delaySec: number | null; // retraso global del trip (null = el feed no lo informa)
  nextStopId: string | null; // próxima parada (stopTimeUpdate; feed con 1 elemento por trip)
  nextStopArrivalSec: number | null; // epoch s de llegada a la próxima parada, si viene
  accessible: boolean | null;
  platform: string | null; // vía/andén desde vehicle.label (VP): 'C5-19789-PLATF.(1)' → '1'
  position: { latitude: number; longitude: number } | null;
  status: string | null; // currentStatus VP: STOPPED_AT | INCOMING_AT | EN_ROUTE...
  vehicleId: string | null; // nº de tren (vehicle.id)
}

export interface RenfeRealtime {
  byTripId: Map<string, RenfeTripRT>;
  feedTimestampMs: number | null; // header.timestamp del feed de Renfe (frescura de la fuente)
  fetchedAtMs: number;
}

const PLATFORM_RE = /PLATF\.\((.+)\)\s*$/;

export function parsePlatformLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const match = PLATFORM_RE.exec(label);
  return match ? match[1].trim() : null;
}

function isMadridTrip(tripId: string): boolean {
  return (
    CRTM_CONFIG.RT.MADRID_TRIP_ID.test(tripId) || CRTM_CONFIG.RT.MADRID_SPECIAL_TRIP_ID.test(tripId)
  );
}

function toSecs(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapScheduleRelationship(value: string | undefined): RenfeTripRT['scheduleRelationship'] {
  switch (value) {
    case 'SCHEDULED':
    case 'CANCELED':
    case 'ADDED':
      return value;
    default:
      return 'UNKNOWN';
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': CRTM_CONFIG.RT.USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(CRTM_CONFIG.RT.FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GTFS-RT Renfe HTTP ${res.status}`);
  return (await res.json()) as T;
}

function entryOf(tripId: string): RenfeTripRT {
  return {
    tripId,
    scheduleRelationship: 'UNKNOWN',
    delaySec: null,
    nextStopId: null,
    nextStopArrivalSec: null,
    accessible: null,
    platform: null,
    position: null,
    status: null,
    vehicleId: null,
  };
}

function buildRealtime(
  tuBody: { header?: { timestamp?: string }; entity?: RawTripUpdateEntity[] } | null,
  vpBody: { entity?: RawVehiclePositionEntity[] } | null,
): RenfeRealtime {
  const byTripId = new Map<string, RenfeTripRT>();

  if (Array.isArray(tuBody?.entity)) {
    for (const entity of tuBody.entity) {
      const tu = entity.tripUpdate;
      const tripId = tu?.trip?.tripId;
      if (!tripId || !isMadridTrip(tripId)) continue;
      const entry = byTripId.get(tripId) ?? entryOf(tripId);
      entry.scheduleRelationship = mapScheduleRelationship(tu?.trip?.scheduleRelationship);
      entry.delaySec = typeof tu?.delay === 'number' ? tu.delay : null;
      const next = tu?.stopTimeUpdate?.[0];
      entry.nextStopId = next?.stopId ?? null;
      entry.nextStopArrivalSec = toSecs(next?.arrival?.time ?? next?.departure?.time);
      if (typeof next?.arrival?.delay === 'number' && entry.delaySec === null) {
        entry.delaySec = next.arrival.delay;
      }
      entry.accessible =
        tu?.vehicle?.wheelchairAccessible === 'WHEELCHAIR_ACCESSIBLE'
          ? true
          : tu?.vehicle?.wheelchairAccessible === 'WHEELCHAIR_INACCESSIBLE'
            ? false
            : null;
      byTripId.set(tripId, entry);
    }
  }

  if (Array.isArray(vpBody?.entity)) {
    for (const entity of vpBody.entity) {
      const vp = entity.vehicle;
      const tripId = vp?.trip?.tripId;
      if (!tripId || !isMadridTrip(tripId)) continue;
      const entry = byTripId.get(tripId) ?? entryOf(tripId);
      if (
        vp?.position &&
        typeof vp.position.latitude === 'number' &&
        typeof vp.position.longitude === 'number'
      ) {
        entry.position = { latitude: vp.position.latitude, longitude: vp.position.longitude };
      }
      if (vp?.currentStatus) entry.status = vp.currentStatus;
      entry.vehicleId = vp?.vehicle?.id ?? null;
      entry.platform = parsePlatformLabel(vp?.vehicle?.label);
      byTripId.set(tripId, entry);
    }
  }

  const feedTs = toSecs(tuBody?.header?.timestamp);
  return {
    byTripId,
    feedTimestampMs: feedTs !== null ? feedTs * 1000 : null,
    fetchedAtMs: Date.now(),
  };
}

// Caché por isolate + single-flight: 2 fetches como máximo cada CACHE_TTL_MS para TODAS
// las estaciones (patrón de getArrivals de la EMT, pero compartida entre peticiones)
let cache: RenfeRealtime | null = null;
let inflight: Promise<RenfeRealtime | null> | null = null;
// Caché negativa: con el feed caído cada petición pagaría el timeout completo de fetch
// (el single-flight solo colapsa las concurrentes); el fallo se recuerda CACHE_TTL_MS
let lastFailureAt = 0;

async function refresh(): Promise<RenfeRealtime | null> {
  // TripUpdates es esencial (retrasos/cancelaciones); VehiclePositions solo enriquece
  // (andén/posición) — su fallo no degrada el tablón
  const [tuResult, vpResult] = await Promise.allSettled([
    fetchJson<Parameters<typeof buildRealtime>[0]>(CRTM_CONFIG.RT.TRIP_UPDATES_URL),
    fetchJson<Parameters<typeof buildRealtime>[1]>(CRTM_CONFIG.RT.VEHICLE_POSITIONS_URL),
  ]);

  if (tuResult.status === 'rejected') {
    // stale-serve: si el feed falla tras caducar el TTL, la última instantánea sirve hasta
    // STALE_MAX_AGE_MS (misma filosofía que arrivals EMT); si tampoco hay, sin tiempo real
    if (cache && Date.now() - cache.fetchedAtMs < CRTM_CONFIG.RT.STALE_MAX_AGE_MS) {
      console.warn(
        `GTFS-RT Renfe trip_updates falló; sirviendo última instantánea (${Math.round((Date.now() - cache.fetchedAtMs) / 1000)}s antigua)`,
      );
      return cache;
    }
    console.warn('GTFS-RT Renfe trip_updates no disponible');
    return null;
  }

  let built: RenfeRealtime;
  try {
    built = buildRealtime(tuResult.value, vpResult.status === 'fulfilled' ? vpResult.value : null);
  } catch (error) {
    // Feed con shape inesperada (entity no iterable, etc.): mismo tratamiento que caída —
    // stale-serve dentro de la gracia o degradación a tablón teórico, nunca 500
    console.warn('GTFS-RT Renfe con formato inesperado; degradando a tablón teórico', error);
    if (cache && Date.now() - cache.fetchedAtMs < CRTM_CONFIG.RT.STALE_MAX_AGE_MS) {
      return cache;
    }
    return null;
  }
  if (vpResult.status === 'rejected') {
    console.warn('GTFS-RT Renfe vehicle_positions no disponible (tablón sin andén/posición)');
  }
  return built;
}

/**
 * Tiempo real de Cercanías Madrid (GTFS-RT de Renfe, núcleo 10), cacheado por isolate.
 * null = feed no disponible (el llamador sirve el tablón teórico con realtime.available false)
 */
export async function getMadridRealtime(): Promise<RenfeRealtime | null> {
  if (cache && Date.now() - cache.fetchedAtMs < CRTM_CONFIG.RT.CACHE_TTL_MS) {
    return cache;
  }
  if (lastFailureAt !== 0 && Date.now() - lastFailureAt < CRTM_CONFIG.RT.CACHE_TTL_MS) {
    return null;
  }
  if (!inflight) {
    inflight = refresh()
      .then((result) => {
        if (result) {
          cache = result;
          lastFailureAt = 0;
        } else {
          lastFailureAt = Date.now();
        }
        return result;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function isRealtimeFresh(rt: RenfeRealtime): boolean {
  // Frescura por NUESTRO último fetch OK (fiable): si obtuvimos TripUpdates hace poco, el
  // snapshot sirve. El header.timestamp de Renfe NO se usa como reloj estricto porque avanza
  // a ritmo irregular (pausas de minutos normales en GTFS-RT) y hacía bascular el tablón
  // entero a "Programado" con el feed funcionando (bandazos 2026-09-01); queda como límite
  // holgado: header más antiguo que FEED_HEADER_MAX_AGE_MS = fuente congelada de verdad.
  if (Date.now() - rt.fetchedAtMs >= CRTM_CONFIG.RT.STALE_MAX_AGE_MS) return false;
  if (rt.feedTimestampMs === null) return true;
  return Date.now() - rt.feedTimestampMs < CRTM_CONFIG.RT.FEED_HEADER_MAX_AGE_MS;
}

// Limpieza para tests
export function __resetRealtimeCache(): void {
  cache = null;
  inflight = null;
  lastFailureAt = 0;
}
