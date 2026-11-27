import { Hono } from 'hono';
import type { Env } from '../types';
import type { Stop } from '../types/emt-data';
import {
  getCachedStops,
  getCachedStopDetail,
  getArrivals,
  StopNotFoundError,
  EMTServiceUnavailableError,
} from '../lib/emt-cache';
import { haversineDistanceM } from '../lib/geo';
import { cacheableHeaders, noStoreHeaders } from '../lib/cache-headers';
import { normalizeText } from '../lib/text-utils';
import { emtStopIndex } from '../lib/search-index';
import { parseNearbyQuery, nearbyResponse } from '../lib/nearby';
import { EMT_SEARCH_CONFIG } from '../lib/config';

const stops = new Hono<{ Bindings: Env }>();

/**
 * Endpoint de búsqueda de paradas
 * Busca por stopId (exacto) o por name (parcial, insensible a mayúsculas/acentos)
 *
 * Query params:
 * - stopId: Busca por ID de parada (exacto)
 * - name: Busca por nombre de parada (parcial, normalizado)
 *
 * Ejemplos:
 * - /search?stopId=123
 * - /search?name=principe
 * - /search?name=sol
 */
stops.get('/search', async (c) => {
  try {
    const stopIdQuery = c.req.query('stopId');
    const nameQuery = c.req.query('name');

    // Validar que al menos uno de los parámetros esté presente
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

    let limit: number = EMT_SEARCH_CONFIG.DEFAULT_LIMIT;
    const limitQuery = c.req.query('limit');
    if (limitQuery !== undefined) {
      limit = Number(limitQuery);
      if (!Number.isInteger(limit) || limit < 1 || limit > EMT_SEARCH_CONFIG.MAX_LIMIT) {
        return c.json(
          {
            status: 'error',
            message: `limit debe ser un entero entre 1 y ${EMT_SEARCH_CONFIG.MAX_LIMIT}`,
            timestamp: new Date().toISOString(),
          },
          400,
        );
      }
    }

    // Índice normalizado del caché (memoizado junto al artefacto): sin él, normalizeText
    // por parada en cada request
    const stopIndex = emtStopIndex(await getCachedStops(c.env));

    let results: Stop[] = [];

    // Búsqueda por stopId (exacta)
    if (stopIdQuery) {
      const entry = stopIndex.find((e) => e.stop.stopId === stopIdQuery);
      if (entry) {
        results = [entry.stop];
      }
    }
    // Búsqueda por nombre (parcial, normalizada)
    else if (nameQuery) {
      const normalizedQuery = normalizeText(nameQuery);

      results = stopIndex.filter((e) => e.name.includes(normalizedQuery)).map((e) => e.stop);
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
    console.error('GET /stops/search falló:', error);
    return c.json(
      {
        status: 'error',
        message: 'Error al buscar paradas',
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
});

/**
 * Endpoint de búsqueda de paradas por cercanía
 * Devuelve las paradas dentro de un radio, ordenadas por distancia
 *
 * Query params:
 * - lat: Latitud del punto (obligatorio)
 * - lon: Longitud del punto (obligatorio)
 * - radius: Radio de búsqueda en metros (opcional, default 300, máx 2000)
 *
 * Ejemplos:
 * - /nearby?lat=40.4172&lon=-3.7038
 * - /nearby?lat=40.4172&lon=-3.7038&radius=500
 */
stops.get('/nearby', async (c) => {
  try {
    const query = parseNearbyQuery(c);
    if (query instanceof Response) return query;

    const allStops = await getCachedStops(c.env);

    const results = allStops
      .map((stop) => ({
        ...stop,
        distanceM: Math.round(
          haversineDistanceM(
            query.lat,
            query.lon,
            stop.coordinates.latitude,
            stop.coordinates.longitude,
          ),
        ),
      }))
      .filter((stop) => stop.distanceM <= query.radius)
      .sort((a, b) => a.distanceM - b.distanceM);

    return nearbyResponse(c, query, results);
  } catch (error) {
    console.error('GET /stops/nearby falló:', error);
    return c.json(
      {
        status: 'error',
        message: 'Error al buscar paradas por cercanía',
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
});

/**
 * Endpoint de detalle de parada
 * Dirección postal, pmv y líneas con dirección/frecuencia/horario en esa parada
 *
 * Params:
 * - stopId: ID de la parada (numérico)
 *
 * Ejemplo:
 * - /detail/62
 */
stops.get('/detail/:stopId', async (c) => {
  try {
    const stopId = c.req.param('stopId');

    if (!/^\d+$/.test(stopId)) {
      return c.json(
        {
          status: 'error',
          message: 'stopId debe ser numérico',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    const detail = await getCachedStopDetail(c.env, stopId);

    return c.json(
      {
        status: 'success',
        message: 'Detalle de parada recuperado correctamente',
        data: detail,
        timestamp: new Date().toISOString(),
      },
      200,
      cacheableHeaders(),
    );
  } catch (error) {
    if (error instanceof StopNotFoundError) {
      return c.json(
        {
          status: 'error',
          message: error.message,
          timestamp: new Date().toISOString(),
        },
        404,
      );
    }
    if (error instanceof EMTServiceUnavailableError) {
      return c.json(
        {
          status: 'error',
          message: error.message,
          timestamp: new Date().toISOString(),
        },
        503,
        { 'Retry-After': '30' },
      );
    }
    console.error('GET /stops/detail falló:', error);
    return c.json(
      {
        status: 'error',
        message: 'Error al obtener el detalle de parada',
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
});

/**
 * Endpoint de próximos autobuses (tiempo real)
 *
 * Path params:
 * - stopId: ID de la parada (numérico)
 *
 * Query params:
 * - line: Línea concreta (opcional; sin ella devuelve todas las líneas de la parada)
 *
 * Ejemplos:
 * - /arrivals/62
 * - /arrivals/62?line=45
 */
stops.get('/arrivals/:stopId', async (c) => {
  try {
    const stopId = c.req.param('stopId');
    const line = c.req.query('line');

    if (!/^\d+$/.test(stopId)) {
      return c.json(
        {
          status: 'error',
          message: 'stopId debe ser numérico',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    if (line && !/^[A-Za-z0-9]+$/.test(line)) {
      return c.json(
        {
          status: 'error',
          message: 'Parámetro line inválido (solo caracteres alfanuméricos)',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    const arrivals = await getArrivals(c.env, stopId, line || undefined);

    return c.json(
      {
        status: 'success',
        message:
          arrivals.length > 0
            ? `${arrivals.length} autobús(es) en camino`
            : 'No hay estimaciones disponibles para esta parada',
        data: {
          stopId,
          line: line || null,
          count: arrivals.length,
          arrivals,
        },
        timestamp: new Date().toISOString(),
      },
      200,
      noStoreHeaders(),
    );
  } catch (error) {
    if (error instanceof StopNotFoundError) {
      return c.json(
        {
          status: 'error',
          message: error.message,
          timestamp: new Date().toISOString(),
        },
        404,
      );
    }
    console.error('GET /stops/arrivals falló:', error);
    return c.json(
      {
        status: 'error',
        message: 'Error al obtener los próximos autobuses',
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
});

export { stops };
