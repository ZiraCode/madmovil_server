import type { Context } from 'hono';
import type { Env } from '../types';
import type { CRTMStop, CRTMArrivalItem } from '../types/crtm-data';
import { getCRTMStopLineDocs, getCRTMWidgetDestinations } from './crtm-cache';
import { computeStopDepartures, resolveWidgetDest, formatHM } from './crtm-schedule';
import { getMadridRealtime, isRealtimeFresh } from './crtm-rt';
import { getWidgetStopTimes, isWidgetStopTimesFresh, resolveWidgetStopCodes } from './crtm-widget';
import type { WidgetStopTimes } from './crtm-widget';
import { madridWallClock } from './date-utils';
import { CRTM_CONFIG } from './config';
import {
  stopNameIndex,
  noScheduleSummary,
  noScheduleMessage,
  type NoScheduleSummary,
} from './crtm-stops';

const CERCANIAS_RT_ATTRIBUTION = 'Tiempo real: Renfe GTFS-RT (CC BY 4.0, data.renfe.com)';
const WIDGET_RT_ATTRIBUTION = 'Tiempo real: widget oficial del CRTM (www.crtm.es)';

/**
 * Llegadas de Cercanías (r_*): tablón teórico GTFS + overlay del GTFS-RT oficial de Renfe
 * (join exacto por trip_id): retrasos, cancelaciones, andén y posición del tren. Refuerzos
 * SPECIAL_* que no existen en el horario teórico se inyectan cuando su próxima parada es
 * la estación. RT caído o congelado → tablón teórico con realtime.available: false.
 */
export async function cercaniasArrivalsResponse(
  c: Context<{ Bindings: Env }>,
  stop: CRTMStop,
  windowMin: number,
  lineQuery: string | null,
  now: number,
  allStops: CRTMStop[],
): Promise<Response> {
  const stopCode = stop.code;
  const docs = await getCRTMStopLineDocs(c.env, stop);
  const noScheduleData = noScheduleSummary(docs, stopCode, lineQuery);
  const stopsByCode = stopNameIndex(allStops);
  // el filtro ?line= va a los docs ANTES de calcular: el cap de SCHEDULE_MAX_RESULTS se
  // consume solo con la línea pedida (en estación con muchas líneas, filtrar después
  // recortaba la ventana de la línea pedida en silencio — C-10)
  const departures = computeStopDepartures(
    docs.filter((d) => !d.noSchedule && (!lineQuery || d.label === lineQuery)),
    stopCode,
    now,
    windowMin * 60,
    CRTM_CONFIG.SCHEDULE_MAX_RESULTS,
    (code) => stopsByCode.get(code),
  );

  const rt = await getMadridRealtime();
  const rtFresh = rt !== null && isRealtimeFresh(rt);
  const bareStopCode = stopCode.slice(2); // r_18000 → 18000 (formato stopId del GTFS-RT)
  const routeIdByLabel = new Map(docs.map((d) => [d.label, d.routeId]));

  const items: CRTMArrivalItem[] = [];
  const seenTripIds = new Set<string>();

  for (const dep of departures) {
    if (dep.tripId) seenTripIds.add(dep.tripId);

    const rtInfo = rtFresh && dep.tripId ? rt!.byTripId.get(dep.tripId) : undefined;
    const scheduledMs = Date.parse(dep.departureISO);
    let estimatedMs = scheduledMs;
    let delaySec: number | null = null;
    // si la próxima parada del tren ES esta estación, arrival.time del feed es la
    // estimación exacta (mejor que programada + delay global)
    if (rtInfo && rtInfo.nextStopId === bareStopCode && rtInfo.nextStopArrivalSec !== null) {
      estimatedMs = rtInfo.nextStopArrivalSec * 1000;
      delaySec = Math.round((estimatedMs - scheduledMs) / 1000);
    } else if (rtInfo && rtInfo.delaySec !== null) {
      delaySec = rtInfo.delaySec;
      estimatedMs = scheduledMs + delaySec * 1000;
    }

    items.push({
      line: dep.line,
      routeId: dep.routeId,
      dest: dep.headsign,
      dir: dep.dir,
      scheduledISO: dep.departureISO,
      estimatedISO: new Date(estimatedMs).toISOString(),
      arrivesInMin: Math.max(0, Math.floor((estimatedMs - now) / 60000)),
      dayOffset: dep.dayOffset,
      time: dep.time,
      realtime: rtInfo !== undefined,
      ...(dep.tripId ? { tripId: dep.tripId } : {}),
      ...(rtInfo?.scheduleRelationship === 'CANCELED' ? { canceled: true } : {}),
      ...(delaySec !== null ? { delaySec } : {}),
      ...(rtInfo?.platform ? { platform: rtInfo.platform } : {}),
      ...(rtInfo?.accessible !== null && rtInfo !== undefined
        ? { accessible: rtInfo.accessible }
        : {}),
      ...(rtInfo?.vehicleId ? { trainId: rtInfo.vehicleId } : {}),
      ...(rtInfo?.status ? { trainStatus: rtInfo.status } : {}),
      ...(rtInfo?.position ? { trainPosition: rtInfo.position } : {}),
      ...(dep.stale ? { stale: true } : {}),
    });
  }

  // Refuerzos y variantes que NO existen en el horario teórico (SPECIAL_10_* / ADDED,
  // o trips del RT de una publicación más reciente que el GTFS estático cacheado):
  // se inyectan cuando su próxima parada es esta estación
  if (rtFresh && rt) {
    for (const rtInfo of rt.byTripId.values()) {
      if (seenTripIds.has(rtInfo.tripId)) continue;
      if (rtInfo.nextStopId !== bareStopCode) continue;
      if (rtInfo.scheduleRelationship === 'CANCELED') continue;
      if (rtInfo.nextStopArrivalSec === null) continue;
      const estimatedMs = rtInfo.nextStopArrivalSec * 1000;
      if (estimatedMs < now || estimatedMs >= now + windowMin * 60_000) continue;
      const lineMatch = /(C\d+[ab]?)$/.exec(rtInfo.tripId);
      if (!lineMatch) continue;
      if (lineQuery && lineMatch[1] !== lineQuery) continue;
      items.push({
        line: lineMatch[1],
        routeId: routeIdByLabel.get(lineMatch[1]) ?? null,
        dest: null,
        dir: null,
        scheduledISO: null,
        estimatedISO: new Date(estimatedMs).toISOString(),
        arrivesInMin: Math.max(0, Math.floor((estimatedMs - now) / 60000)),
        dayOffset: null,
        time: null,
        realtime: true,
        added: true,
        tripId: rtInfo.tripId,
        ...(rtInfo.platform ? { platform: rtInfo.platform } : {}),
        ...(rtInfo.accessible !== null ? { accessible: rtInfo.accessible } : {}),
        ...(rtInfo.vehicleId ? { trainId: rtInfo.vehicleId } : {}),
        ...(rtInfo.status ? { trainStatus: rtInfo.status } : {}),
        ...(rtInfo.position ? { trainPosition: rtInfo.position } : {}),
      });
    }
  }

  items.sort((a, b) => Date.parse(a.estimatedISO) - Date.parse(b.estimatedISO));

  return c.json(
    {
      status: 'success',
      message:
        items.length > 0
          ? `${items.length} salida(s) en los próximos ${windowMin} min${rtFresh ? '' : ' (tiempo real no disponible: horario teórico)'}`
          : noScheduleData
            ? noScheduleMessage(noScheduleData)
            : `No hay salidas en los próximos ${windowMin} min`,
      data: {
        stopCode,
        stop: {
          code: stop.code,
          name: stop.name,
          municipality: stop.municipality,
          zone: stop.zone,
        },
        date: madridWallClock(now).dateISO,
        windowMin,
        count: items.length,
        departures: items,
        realtime: {
          available: rtFresh,
          ...(rt?.feedTimestampMs
            ? { feedTimestamp: new Date(rt.feedTimestampMs).toISOString() }
            : {}),
        },
        attribution: CERCANIAS_RT_ATTRIBUTION,
        ...(noScheduleData ? { noScheduleData } : {}),
      },
      timestamp: new Date().toISOString(),
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
}

/**
 * Llegadas de bus interurbano/urbano, ML y metro: API del widget oficial del CRTM
 * (estimaciones del SAE por línea; el codLine del widget es nuestro routeId GTFS y en bus
 * el modo del poste 8_/9_ se resuelve y cachea vía GetStops.php). Widget caído, congelado
 * o VIVO pero sin tiempos para la parada → tablón teórico GTFS con realtime.available:
 * false (200, degradado).
 */
export async function widgetArrivalsResponse(
  c: Context<{ Bindings: Env }>,
  stop: CRTMStop,
  windowMin: number,
  lineQuery: string | null,
  now: number,
  allStops: CRTMStop[],
): Promise<Response> {
  const stopCode = stop.code;
  const codStops = await resolveWidgetStopCodes(c.env, stopCode);
  // Paralelo: un poste puede resolver a 8_ y 9_ (modos del widget) y cada await encadenado
  // sumaba hasta FETCH_TIMEOUT_MS; el orden de los items lo marca el sort por estimatedISO
  const settled = await Promise.all(codStops.map((code) => getWidgetStopTimes(code)));
  const snapshots = settled.filter(
    (snapshot): snapshot is WidgetStopTimes =>
      snapshot !== null && isWidgetStopTimesFresh(snapshot),
  );
  const widgetUp = snapshots.length > 0;

  const items: CRTMArrivalItem[] = [];
  let feedTimestampMs: number | null = null;
  let noScheduleData: NoScheduleSummary | null = null;
  const stopsByCode = stopNameIndex(allStops);

  if (widgetUp) {
    // Destino canónico por (routeId, dir): el SAE manda como dest la última parada física del
    // sentido; la UI muestra el oficial (mode(dest) > cabecera, igual que detail/timetable)
    // solo cuando el dest del SAE ES la terminal del sentido — variantes cortas reales intactas
    const routeIds = [...new Set(snapshots.flatMap((s) => s.arrivals.map((a) => a.routeId)))];
    const destinations = await getCRTMWidgetDestinations(c.env, routeIds, (code) =>
      stopsByCode.get(code),
    );
    for (const snapshot of snapshots) {
      // minutos contra el reloj del backend CRTM (actualDate), no contra el nuestro
      const referenceMs = snapshot.actualDateMs ?? now;
      if (snapshot.actualDateMs !== null && snapshot.actualDateMs > (feedTimestampMs ?? 0)) {
        feedTimestampMs = snapshot.actualDateMs;
      }
      for (const arrival of snapshot.arrivals) {
        if (lineQuery && arrival.line !== lineQuery) continue;
        if (arrival.timeMs < referenceMs - 30_000) continue; // llegada ya efectiva (tolerancia)
        if (arrival.timeMs > referenceMs + windowMin * 60_000) continue;
        items.push({
          line: arrival.line,
          routeId: arrival.routeId,
          ...(arrival.network ? { network: arrival.network } : {}),
          ...(arrival.lineName ? { lineName: arrival.lineName } : {}),
          dest:
            resolveWidgetDest(destinations.get(arrival.routeId), arrival.dir, arrival.dest) ??
            arrival.dest,
          dir: arrival.dir,
          scheduledISO: null,
          estimatedISO: new Date(arrival.timeMs).toISOString(),
          arrivesInMin: Math.max(0, Math.floor((arrival.timeMs - referenceMs) / 60000)),
          dayOffset: 0,
          time: formatHM(madridWallClock(arrival.timeMs).secsOfDay),
          realtime: arrival.realtime,
          ...(arrival.vehicle ? { vehicle: arrival.vehicle } : {}),
        });
      }
    }
    items.sort((a, b) => Date.parse(a.estimatedISO) - Date.parse(b.estimatedISO));
  }

  // Board vacío → tablón teórico, tanto si el widget está caído/congelado como si está
  // VIVO pero el SAE no publica tiempos para esta parada (hallazgo 2026-11-28, 09103
  // Torrelodones: actualDate fresca, SAEStatus true en sus 4 líneas y times {} TODO el
  // día con salidas GTFS dentro de la ventana — servir "no hay llegadas" ahí es mentir).
  // Si el teórico tampoco tiene salidas se conserva la respuesta del widget (available
  // true = "no hay vehículos ahora"), distinguible del vacío por la causa real
  let rtAvailable = widgetUp;
  if (items.length === 0) {
    // ?line= filtra los docs antes del cap (mismo criterio que cercanías y que schedule — C-10)
    const docs = await getCRTMStopLineDocs(c.env, stop);
    noScheduleData = noScheduleSummary(docs, stopCode, lineQuery);
    const departures = computeStopDepartures(
      docs.filter((d) => !d.noSchedule && (!lineQuery || d.label === lineQuery)),
      stopCode,
      now,
      windowMin * 60,
      CRTM_CONFIG.SCHEDULE_MAX_RESULTS,
      (code) => stopsByCode.get(code),
    );

    for (const dep of departures) {
      const estimatedMs = Date.parse(dep.departureISO);
      items.push({
        line: dep.line,
        routeId: dep.routeId,
        network: dep.network,
        dest: dep.headsign,
        dir: dep.dir,
        scheduledISO: dep.departureISO,
        estimatedISO: dep.departureISO,
        arrivesInMin: Math.max(0, Math.floor((estimatedMs - now) / 60000)),
        dayOffset: dep.dayOffset,
        time: dep.time,
        realtime: false,
        ...(dep.stale ? { stale: true } : {}),
      });
    }
    if (items.length > 0) rtAvailable = false;
  }

  return c.json(
    {
      status: 'success',
      message:
        items.length > 0
          ? `${items.length} llegada(s) en los próximos ${windowMin} min${rtAvailable ? '' : ' (tiempo real no disponible: horario teórico)'}`
          : rtAvailable
            ? `No hay llegadas en los próximos ${windowMin} min`
            : noScheduleData
              ? noScheduleMessage(noScheduleData)
              : `No hay salidas en los próximos ${windowMin} min`,
      data: {
        stopCode,
        stop: {
          code: stop.code,
          name: stop.name,
          municipality: stop.municipality,
          zone: stop.zone,
        },
        date: madridWallClock(now).dateISO,
        windowMin,
        count: items.length,
        departures: items,
        realtime: {
          available: rtAvailable,
          source: 'crtm-widget',
          ...(feedTimestampMs !== null
            ? { feedTimestamp: new Date(feedTimestampMs).toISOString() }
            : {}),
        },
        attribution: WIDGET_RT_ATTRIBUTION,
        ...(noScheduleData ? { noScheduleData } : {}),
      },
      timestamp: new Date().toISOString(),
    },
    200,
    { 'Cache-Control': 'no-store' },
  );
}
