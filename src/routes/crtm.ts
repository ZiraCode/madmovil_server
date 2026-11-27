import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import type { CRTMStop } from '../types/crtm-data';
import {
  getCRTMStops,
  getCRTMLinesAll,
  getCRTMMeta,
  getCRTMStopLineDocs,
  resolveCRTMLineDocs,
  getCRTMLineRoute,
  CRTMDataUnavailableError,
  CRTMStopNotFoundError,
  CRTMLineNotFoundError,
  CRTMNoGeometryError,
} from '../lib/crtm-cache';
import {
  computeStopDepartures,
  computeStopDayDepartures,
  buildLineTimetable,
  resolveDirectionDestinations,
  modeDestByDirection,
} from '../lib/crtm-schedule';
import { cercaniasArrivalsResponse, widgetArrivalsResponse } from '../lib/crtm-arrivals';
import {
  getCercaniasIncidents,
  resolveIncidentStopCode,
  CRTMIncidentsUnavailableError,
} from '../lib/crtm-incidents';
import type { CercaniasIncident } from '../lib/crtm-incidents';
import { haversineDistanceM } from '../lib/geo';
import { cacheableHeaders } from '../lib/cache-headers';
import { normalizeText } from '../lib/text-utils';
import { crtmStopIndex } from '../lib/search-index';
import { stopNameIndex, stopIndex, noScheduleSummary, noScheduleMessage } from '../lib/crtm-stops';
import { madridWallClock, dateWithinWindow, formatYmd } from '../lib/date-utils';
import { CRTM_CONFIG, CRTM_PATTERNS } from '../lib/config';
import { parseNearbyQuery, nearbyResponse } from '../lib/nearby';
const CRTM_ATTRIBUTION =
  '© Consorcio Regional de Transportes de Madrid (CRTM) · Cercanías: Renfe (datos del NAP, nap.transportes.gob.es) · Tiempo real: Renfe GTFS-RT (CC BY 4.0, data.renfe.com) y widget oficial del CRTM (www.crtm.es)';
const INCIDENTS_ATTRIBUTION = 'Incidencias: widget oficial del CRTM (www.crtm.es)';

const crtm = new Hono<{ Bindings: Env }>();

/**
 * Mapeo común de errores CRTM: 404 (parada/línea inexistente o línea sin geometría) y 503 (artefactos sin cargar)
 */
function crtmErrorResponse(
  c: Context<{ Bindings: Env }>,
  error: unknown,
  fallbackMessage: string,
): Response {
  if (
    error instanceof CRTMStopNotFoundError ||
    error instanceof CRTMLineNotFoundError ||
    error instanceof CRTMNoGeometryError
  ) {
    return c.json(
      {
        status: 'error',
        message: error.message,
        timestamp: new Date().toISOString(),
      },
      404,
    );
  }
  if (error instanceof CRTMDataUnavailableError || error instanceof CRTMIncidentsUnavailableError) {
    return c.json(
      {
        status: 'error',
        message: error.message,
        timestamp: new Date().toISOString(),
      },
      503,
      { 'Retry-After': '300' },
    );
  }
  console.error(`${c.req.method} ${c.req.path} falló:`, error);
  return c.json(
    {
      status: 'error',
      message: fallbackMessage,
      timestamp: new Date().toISOString(),
    },
    500,
  );
}

/**
 * GET /crtm/stops/search?stopId=|name=&limit=
 * Búsqueda por código exacto o por nombre/dirección/municipio (parcial, normalizado).
 * Query puramente numérica: solo matchea como número de vía completo (frontera de dígitos),
 * para que "62" no devuelva direcciones como "Ctra del Escorial 16200".
 * limit recorta el listado (default 30, máx 100); count devuelve siempre el total de coincidencias
 */
crtm.get('/stops/search', async (c) => {
  try {
    const stopIdQuery = c.req.query('stopId');
    const nameQuery = c.req.query('name');

    if (!stopIdQuery && !nameQuery) {
      return c.json(
        {
          status: 'error',
          message: 'Se requiere al menos uno de los parámetros: stopId o name',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    // Query que normaliza a vacío (solo símbolos/espacios): includes('') matchearía TODAS las paradas
    if (nameQuery && normalizeText(nameQuery).length === 0) {
      return c.json(
        {
          status: 'error',
          message: 'El parámetro name debe contener algún carácter de búsqueda',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    let limit: number = CRTM_CONFIG.SEARCH_DEFAULT_LIMIT;
    const limitQuery = c.req.query('limit');
    if (limitQuery !== undefined) {
      limit = Number(limitQuery);
      if (!Number.isInteger(limit) || limit < 1 || limit > CRTM_CONFIG.SEARCH_MAX_LIMIT) {
        return c.json(
          {
            status: 'error',
            message: `limit debe ser un entero entre 1 y ${CRTM_CONFIG.SEARCH_MAX_LIMIT}`,
            timestamp: new Date().toISOString(),
          },
          400,
        );
      }
    }

    // Índice normalizado del artefacto (memoizado junto a él): sin él, hasta 3 normalizeText
    // por parada en cada request (~8k paradas)
    const stopIndex = crtmStopIndex(await getCRTMStops(c.env));

    let results: CRTMStop[] = [];
    if (stopIdQuery) {
      const entry = stopIndex.find((e) => e.stop.code === stopIdQuery);
      if (entry) {
        results = [entry.stop];
      }
    } else if (nameQuery) {
      const normalizedQuery = normalizeText(nameQuery);
      if (/^\d+$/.test(normalizedQuery)) {
        const boundary = new RegExp(`(?:^|\\D)${normalizedQuery}(?:\\D|$)`);
        results = stopIndex
          .filter(
            (e) =>
              boundary.test(e.name) || boundary.test(e.address) || boundary.test(e.municipality),
          )
          .map((e) => e.stop);
      } else {
        results = stopIndex
          .filter(
            (e) =>
              e.name.includes(normalizedQuery) ||
              e.address.includes(normalizedQuery) ||
              e.municipality.includes(normalizedQuery),
          )
          .map((e) => e.stop);
      }
    }

    const returned = results.slice(0, limit);

    return c.json(
      {
        status: 'success',
        message:
          results.length > 0
            ? `Se encontraron ${results.length} parada(s)`
            : 'No se encontraron paradas que coincidan con la búsqueda',
        data: {
          query: {
            stopId: stopIdQuery || null,
            name: nameQuery || null,
          },
          count: results.length,
          returned: returned.length,
          stops: returned,
        },
        timestamp: new Date().toISOString(),
      },
      200,
      cacheableHeaders(),
    );
  } catch (error) {
    return crtmErrorResponse(c, error, 'Error al buscar paradas CRTM');
  }
});

/**
 * GET /crtm/stops/nearby?lat=&lon=&radius=
 * Paradas dentro de un radio ordenadas por distancia (haversine sobre crtm:stops:all)
 */
crtm.get('/stops/nearby', async (c) => {
  try {
    const query = parseNearbyQuery(c);
    if (query instanceof Response) return query;

    const allStops = await getCRTMStops(c.env);

    const results = allStops
      .filter((stop) => typeof stop.lat === 'number' && typeof stop.lon === 'number')
      .map((stop) => ({
        ...stop,
        distanceM: Math.round(
          haversineDistanceM(query.lat, query.lon, stop.lat as number, stop.lon as number),
        ),
      }))
      .filter((stop) => stop.distanceM <= query.radius)
      .sort((a, b) => a.distanceM - b.distanceM);

    return nearbyResponse(c, query, results);
  } catch (error) {
    return crtmErrorResponse(c, error, 'Error al buscar paradas CRTM por cercanía');
  }
});

/**
 * GET /crtm/stops/schedule/:stopCode?window= | ?date=&line=
 * Próximas salidas teóricas de una parada (sustituto de arrivals hasta la parte 2 de CRTM):
 * calendario GTFS del día en hora Madrid, ventana de 2h por defecto (máx 6h),
 * horas ≥24:00 del día de servicio anterior incluidas como salidas de madrugada.
 * Si ninguna patrón activo de una línea cubre el día (feed con rangos truncados),
 * se sirve la última generación caducada de ese día de la semana: salidas con stale:true
 * y data.calendarFallback:true
 *
 * Con date=YYYY-MM-DD (modo fecha, hoy..hoy+14 en hora de Madrid): tablón teórico del
 * día COMPLETO, ordenado por hora efectiva — madrugadas ≥24:00 del servicio del día
 * anterior incluidas y, para hoy, también las salidas ya pasadas (la UI las atenúa).
 * window se ignora en modo fecha. line= filtra por label de línea en ambos modos.
 */
crtm.get('/stops/schedule/:stopCode', async (c) => {
  try {
    const stopCode = c.req.param('stopCode');

    // admite códigos namespacelados de ml/metro (p. ej. 10_5) además de los numéricos de bus
    if (!CRTM_PATTERNS.STOP_CODE.test(stopCode)) {
      return c.json(
        {
          status: 'error',
          message: 'stopCode inválido (solo caracteres alfanuméricos)',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    const dateQuery = c.req.query('date');
    let dateKey: string | null = null;
    if (dateQuery !== undefined) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateQuery);
      // round-trip UTC para rechazar fechas inexistentes (2026-02-30 rueda a 2026-03-02)
      const isRealDate =
        match !== null &&
        new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
          .toISOString()
          .slice(0, 10) === dateQuery;
      if (
        !isRealDate ||
        !dateWithinWindow(dateQuery.replace(/-/g, ''), 0, CRTM_CONFIG.SCHEDULE_DATE_MAX_OFFSET_DAYS)
      ) {
        return c.json(
          {
            status: 'error',
            message: `date debe ser una fecha válida YYYY-MM-DD entre hoy y hoy+${CRTM_CONFIG.SCHEDULE_DATE_MAX_OFFSET_DAYS} días (hora de Madrid)`,
            timestamp: new Date().toISOString(),
          },
          400,
        );
      }
      dateKey = dateQuery.replace(/-/g, '');
    }

    let windowMin: number = CRTM_CONFIG.SCHEDULE_WINDOW_DEFAULT_MIN;
    const windowQuery = c.req.query('window');
    if (windowQuery !== undefined && dateKey === null) {
      windowMin = Number(windowQuery);
      if (
        !Number.isInteger(windowMin) ||
        windowMin < CRTM_CONFIG.SCHEDULE_WINDOW_MIN ||
        windowMin > CRTM_CONFIG.SCHEDULE_WINDOW_MAX
      ) {
        return c.json(
          {
            status: 'error',
            message: `window debe ser un entero entre ${CRTM_CONFIG.SCHEDULE_WINDOW_MIN} y ${CRTM_CONFIG.SCHEDULE_WINDOW_MAX} minutos`,
            timestamp: new Date().toISOString(),
          },
          400,
        );
      }
    }

    const lineQuery = c.req.query('line')?.trim() || null;

    const now = Date.now();
    const allStops = await getCRTMStops(c.env);
    const stop = allStops.find((s) => s.code === stopCode);
    if (!stop) {
      throw new CRTMStopNotFoundError(stopCode);
    }

    const docs = await getCRTMStopLineDocs(c.env, stop);
    // Redes en modo catálogo (feed stale): la parada es de esa línea pero no hay horarios
    // oficiales → 200 con noScheduleData en vez de un vacío indistinguible
    const noScheduleData = noScheduleSummary(docs, stopCode, lineQuery);
    const stopsByCode = stopNameIndex(allStops);
    const activeDocs = docs.filter((d) => !d.noSchedule && (!lineQuery || d.label === lineQuery));
    const departures =
      dateKey !== null
        ? computeStopDayDepartures(
            activeDocs,
            stopCode,
            dateKey,
            CRTM_CONFIG.SCHEDULE_DAY_MAX_RESULTS,
            (code) => stopsByCode.get(code),
          )
        : computeStopDepartures(
            activeDocs,
            stopCode,
            now,
            windowMin * 60,
            CRTM_CONFIG.SCHEDULE_MAX_RESULTS,
            (code) => stopsByCode.get(code),
          );
    const calendarFallback = departures.some((d) => d.stale === true);
    const truncated =
      dateKey !== null && departures.length === CRTM_CONFIG.SCHEDULE_DAY_MAX_RESULTS;

    return c.json(
      {
        status: 'success',
        message:
          dateKey !== null
            ? departures.length > 0
              ? `${departures.length} salida(s) teórica(s) para el ${formatYmd(dateKey)}${truncated ? ' (se muestran las primeras ' + departures.length + ')' : ''}`
              : noScheduleData
                ? noScheduleMessage(noScheduleData)
                : `No hay salidas teóricas para el ${formatYmd(dateKey)}`
            : departures.length > 0
              ? `${departures.length} salida(s) teórica(s) en los próximos ${windowMin} min`
              : noScheduleData
                ? noScheduleMessage(noScheduleData)
                : `No hay salidas teóricas en los próximos ${windowMin} min`,
        data: {
          stopCode,
          stop: {
            code: stop.code,
            name: stop.name,
            municipality: stop.municipality,
            zone: stop.zone,
          },
          date: dateKey !== null ? dateQuery : madridWallClock(now).dateISO,
          ...(dateKey === null ? { windowMin } : {}),
          count: departures.length,
          departures,
          // true si alguna salida usa el fallback de calendario caducado (patrón teórico obsoleto del feed)
          ...(calendarFallback ? { calendarFallback: true } : {}),
          // presente si la parada pertenece a líneas de red(es) sin horarios oficiales (modo catálogo)
          ...(noScheduleData ? { noScheduleData } : {}),
        },
        timestamp: new Date().toISOString(),
      },
      200,
      dateKey !== null ? cacheableHeaders() : cacheableHeaders(60, 300),
    );
  } catch (error) {
    return crtmErrorResponse(c, error, 'Error al obtener las salidas de la parada CRTM');
  }
});

/**
 * GET /crtm/stops/arrivals/:stopCode?window=&line=
 * Próximas llegadas con tiempo real:
 * - r_* (Cercanías): tablón teórico GTFS + overlay del GTFS-RT oficial de Renfe (join exacto
 *   por trip_id): retrasos, cancelaciones, andén y posición del tren. Refuerzos SPECIAL_*
 *   que no existen en el horario teórico se inyectan cuando su próxima parada es la estación.
 * - resto (bus interurbano/urbano, ML, metro): API del widget oficial del CRTM (estimaciones
 *   del SAE por línea). El codLine del widget es nuestro routeId GTFS; en bus el modo del
 *   poste (8_/9_) se resuelve y cachea vía GetStops.php.
 * Fuente caída o caduca → tablón teórico con realtime.available: false (200, degradado).
 * Cache-Control no-store (datos en tiempo real).
 */
crtm.get('/stops/arrivals/:stopCode', async (c) => {
  try {
    const stopCode = c.req.param('stopCode');

    // admite códigos namespacelados (r_*, 10_*, 4_*) además de los numéricos de bus
    if (!CRTM_PATTERNS.STOP_CODE.test(stopCode)) {
      return c.json(
        {
          status: 'error',
          message: 'stopCode inválido (solo caracteres alfanuméricos)',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    let windowMin: number = CRTM_CONFIG.ARRIVALS_WINDOW_DEFAULT_MIN;
    const windowQuery = c.req.query('window');
    if (windowQuery !== undefined) {
      windowMin = Number(windowQuery);
      if (
        !Number.isInteger(windowMin) ||
        windowMin < CRTM_CONFIG.ARRIVALS_WINDOW_MIN ||
        windowMin > CRTM_CONFIG.ARRIVALS_WINDOW_MAX
      ) {
        return c.json(
          {
            status: 'error',
            message: `window debe ser un entero entre ${CRTM_CONFIG.ARRIVALS_WINDOW_MIN} y ${CRTM_CONFIG.ARRIVALS_WINDOW_MAX} minutos`,
            timestamp: new Date().toISOString(),
          },
          400,
        );
      }
    }

    const lineQuery = c.req.query('line')?.trim() || null;

    const now = Date.now();
    const allStops = await getCRTMStops(c.env);
    const stop = allStops.find((s) => s.code === stopCode);
    if (!stop) {
      throw new CRTMStopNotFoundError(stopCode);
    }

    return /^r_/.test(stopCode)
      ? await cercaniasArrivalsResponse(c, stop, windowMin, lineQuery, now, allStops)
      : await widgetArrivalsResponse(c, stop, windowMin, lineQuery, now, allStops);
  } catch (error) {
    return crtmErrorResponse(c, error, 'Error al obtener las llegadas de la parada CRTM');
  }
});

/**
 * GET /crtm/lines
 * Todas las líneas (chips): label, routeId, name, network, municipality
 */
crtm.get('/lines', async (c) => {
  try {
    const all = await getCRTMLinesAll(c.env);

    return c.json(
      {
        status: 'success',
        message: `Se encontraron ${all.lines.length} línea(s)`,
        data: {
          count: all.lines.length,
          lines: all.lines,
        },
        timestamp: new Date().toISOString(),
      },
      200,
      cacheableHeaders(),
    );
  } catch (error) {
    return crtmErrorResponse(c, error, 'Error al obtener las líneas CRTM');
  }
});

/**
 * GET /crtm/lines/detail/:id (routeId exacto o label)
 * Info de la línea + direcciones con las paradas ordenadas (enriquecidas con nombre/coords de stops:all)
 * Un label puede existir en las dos redes → data.lines puede traer más de un doc
 */
crtm.get('/lines/detail/:id', async (c) => {
  try {
    const id = c.req.param('id');

    if (!CRTM_PATTERNS.LINE_ID.test(id)) {
      return c.json(
        {
          status: 'error',
          message: 'id inválido (label o routeId de línea)',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    const [docs, allStops] = await Promise.all([
      resolveCRTMLineDocs(c.env, id),
      getCRTMStops(c.env),
    ]);
    const stopsByCode = stopIndex(allStops);

    const lines = docs.map((doc) => {
      const destinations = resolveDirectionDestinations(doc, (code) => stopsByCode.get(code)?.name);
      const modeDest = modeDestByDirection(doc);
      return {
        label: doc.label,
        routeId: doc.routeId,
        name: doc.name,
        network: doc.network,
        municipality: doc.municipality,
        url: doc.url,
        ...(doc.color ? { color: doc.color } : {}),
        ...(doc.textColor ? { textColor: doc.textColor } : {}),
        ...(doc.noSchedule ? { noSchedule: doc.noSchedule } : {}),
        tripCount: doc.trips?.length ?? 0,
        directions: doc.directions.map((d) => ({
          id: d.id,
          // dest modal por trip (canónico del widget) > cabecera resuelta > headsign GTFS
          headsign: modeDest[d.id] ?? destinations[d.id] ?? d.headsign,
          stops: d.stops.map((code) => {
            const stop = stopsByCode.get(code);
            return {
              code,
              name: stop?.name ?? null,
              lat: stop?.lat ?? null,
              lon: stop?.lon ?? null,
            };
          }),
        })),
        services: doc.services ?? [],
      };
    });

    return c.json(
      {
        status: 'success',
        message: `Detalle recuperado para ${lines.length} línea(s)`,
        data: {
          query: id,
          count: lines.length,
          lines,
        },
        timestamp: new Date().toISOString(),
      },
      200,
      cacheableHeaders(),
    );
  } catch (error) {
    return crtmErrorResponse(c, error, 'Error al obtener el detalle de línea CRTM');
  }
});

/**
 * GET /crtm/lines/timetable/:id (routeId exacto o label)
 * Primer/último servicio y nº de expediciones por dirección, desglosado por patrón de servicio
 * Horas en formato GTFS: las ≥24:00 son madrugada del mismo día de servicio
 */
crtm.get('/lines/timetable/:id', async (c) => {
  try {
    const id = c.req.param('id');

    if (!CRTM_PATTERNS.LINE_ID.test(id)) {
      return c.json(
        {
          status: 'error',
          message: 'id inválido (label o routeId de línea)',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    const [docs, allStops] = await Promise.all([
      resolveCRTMLineDocs(c.env, id),
      getCRTMStops(c.env),
    ]);
    const stopsByCode = stopNameIndex(allStops);

    const lines = docs.map((doc) => {
      const destinations = resolveDirectionDestinations(doc, (code) => stopsByCode.get(code));
      const modeDest = modeDestByDirection(doc);
      return {
        label: doc.label,
        routeId: doc.routeId,
        name: doc.name,
        network: doc.network,
        municipality: doc.municipality,
        // red en modo catálogo: first/last/trips nulos (sin horarios oficiales)
        ...(doc.noSchedule ? { noSchedule: doc.noSchedule } : {}),
        directions: buildLineTimetable(doc).map((d) => ({
          ...d,
          // dest modal por trip (canónico del widget) > cabecera resuelta > headsign GTFS
          headsign: modeDest[d.id] ?? destinations[d.id] ?? d.headsign,
        })),
      };
    });
    const noScheduleOnly = docs.length > 0 && docs.every((d) => d.noSchedule);

    return c.json(
      {
        status: 'success',
        message: noScheduleOnly
          ? 'Sin horarios oficiales para esta línea (feed CRTM sin calendario vigente)'
          : 'Horarios de línea recuperados correctamente',
        data: {
          query: id,
          count: lines.length,
          lines,
        },
        timestamp: new Date().toISOString(),
      },
      200,
      cacheableHeaders(),
    );
  } catch (error) {
    return crtmErrorResponse(c, error, 'Error al obtener los horarios de línea CRTM');
  }
});

/**
 * GET /crtm/lines/route/:routeId (routeId EXACTO, no resuelve labels)
 * Geometría del recorrido en GeoJSON directo para Leaflet: por dirección (id/headsign
 * iguales que detail) MultiLineString con un tramo por hueco > 500 m del shape original.
 * Las paradas no van aquí (detail ya las da). 404 distingue routeId inexistente
 * ("No existe la línea CRTM") de línea válida sin shapes en su feed ("no tiene geometría").
 */
crtm.get('/lines/route/:routeId', async (c) => {
  try {
    const routeId = c.req.param('routeId');

    if (!CRTM_PATTERNS.ROUTE_ID.test(routeId)) {
      return c.json(
        {
          status: 'error',
          message: 'routeId inválido (routeId exacto de línea CRTM, p. ej. 8__421___)',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    const doc = await getCRTMLineRoute(c.env, routeId);

    return c.json(
      {
        status: 'success',
        message: `Recorrido recuperado (${doc.directions.length} dirección(es))`,
        data: doc,
        timestamp: new Date().toISOString(),
      },
      200,
      cacheableHeaders(),
    );
  } catch (error) {
    return crtmErrorResponse(c, error, 'Error al obtener el recorrido de línea CRTM');
  }
});

/**
 * GET /crtm/lines/incidents/:id (routeId exacto, label o 'all')
 * Incidencias/afectaciones de cercanías (obras, servicios sustitutivos) del widget oficial
 * del CRTM: feed del SAE consultado a nivel de red (mode=5) y filtrado local por label —
 * el codLine del widget (5__C9___) no es nuestro routeId (10T_C9). Línea válida de otra red
 * → 200 con incidentsAvailable: false (el feed solo publica cercanías por ahora, sin gasto
 * de fetch). Widget caído sin caché → 503 + Retry-After. La línea se valida contra lines:all
 * ANTES de tocar la fuente externa (404 sin gasto).
 */
crtm.get('/lines/incidents/:id', async (c) => {
  try {
    const id = c.req.param('id');

    if (!CRTM_PATTERNS.LINE_ID.test(id)) {
      return c.json(
        {
          status: 'error',
          message: 'id inválido (label o routeId de línea)',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    const all = await getCRTMLinesAll(c.env);
    const cercaniasMatches =
      id === 'all'
        ? []
        : all.lines.filter(
            (l) => (l.routeId === id || l.label === id) && l.network === 'cercanias',
          );

    if (id !== 'all') {
      if (all.lines.every((l) => l.routeId !== id && l.label !== id)) {
        throw new CRTMLineNotFoundError(id);
      }
      if (cercaniasMatches.length === 0) {
        return c.json(
          {
            status: 'success',
            message: 'Incidencias disponibles solo para líneas de Cercanías',
            data: {
              query: id,
              count: 0,
              incidents: [],
              incidentsAvailable: false,
              attribution: INCIDENTS_ATTRIBUTION,
            },
            timestamp: new Date().toISOString(),
          },
          200,
          cacheableHeaders(300, CRTM_CONFIG.INCIDENTS.TTL),
        );
      }
    }

    const incidents = await getCercaniasIncidents(c.env);
    const cercaniasLines = all.lines.filter((l) => l.network === 'cercanias');
    const routeIdByLabel = new Map(cercaniasLines.map((l) => [l.label, l.routeId]));
    // estaciones de cercanías para enlazar las paradas afectadas (r_* por nombre del widget)
    const cercaniasStops = incidents.some((i) => i.affectedStops.length > 0)
      ? (await getCRTMStops(c.env)).filter((s) => s.code.startsWith('r_'))
      : [];

    const withStopCodes = (list: CercaniasIncident[]) =>
      list.map((inc) => ({
        label: inc.label,
        routeId: inc.label !== null ? (routeIdByLabel.get(inc.label) ?? null) : null,
        type: inc.type,
        description: inc.description,
        affectedStops: inc.affectedStops.map((s) => ({
          name: s.name,
          stopCode: resolveIncidentStopCode(s.name, cercaniasStops),
        })),
      }));

    if (id === 'all') {
      const items = withStopCodes(incidents);
      return c.json(
        {
          status: 'success',
          message:
            items.length > 0
              ? `${items.length} incidencia(s) en Cercanías`
              : 'Sin incidencias en Cercanías',
          data: {
            query: id,
            count: items.length,
            incidents: items,
            attribution: INCIDENTS_ATTRIBUTION,
          },
          timestamp: new Date().toISOString(),
        },
        200,
        cacheableHeaders(300, CRTM_CONFIG.INCIDENTS.TTL),
      );
    }

    const labels = new Set(cercaniasMatches.map((l) => l.label));
    const line = cercaniasMatches[0];
    const items = withStopCodes(
      incidents.filter((inc) => inc.label !== null && labels.has(inc.label)),
    );

    return c.json(
      {
        status: 'success',
        message:
          items.length > 0
            ? `${items.length} incidencia(s) para la línea ${line.label}`
            : `Sin incidencias para la línea ${line.label}`,
        data: {
          query: id,
          label: line.label,
          routeId: line.routeId,
          network: 'cercanias',
          count: items.length,
          incidents: items,
          attribution: INCIDENTS_ATTRIBUTION,
        },
        timestamp: new Date().toISOString(),
      },
      200,
      cacheableHeaders(300, CRTM_CONFIG.INCIDENTS.TTL),
    );
  } catch (error) {
    return crtmErrorResponse(c, error, 'Error al obtener las incidencias de línea CRTM');
  }
});

/**
 * GET /crtm/status
 * Estado de los artefactos (crtm:meta) + atribución de la fuente
 */
crtm.get('/status', async (c) => {
  try {
    const meta = await getCRTMMeta(c.env);
    if (!meta) {
      throw new CRTMDataUnavailableError();
    }

    return c.json(
      {
        status: 'success',
        message: 'Datos CRTM cargados',
        data: {
          generatedAt: meta.generatedAt,
          versions: meta.versions,
          counts: meta.counts,
          ...(meta.shapes ? { shapes: meta.shapes } : {}),
          attribution: CRTM_ATTRIBUTION,
        },
        timestamp: new Date().toISOString(),
      },
      200,
      cacheableHeaders(),
    );
  } catch (error) {
    return crtmErrorResponse(c, error, 'Error al obtener el estado CRTM');
  }
});

export { crtm };
