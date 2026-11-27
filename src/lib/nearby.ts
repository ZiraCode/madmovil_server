import type { Context } from 'hono';
import type { Env } from '../types';
import { cacheableHeaders } from './cache-headers';
import { NEARBY_CONFIG } from './config';

/**
 * Validación compartida de /stops/nearby y /crtm/stops/nearby: lat/lon obligatorios y
 * acotados, radius opcional (default 300 m, máx 2000 m). Devuelve la Response de error
 * o los valores ya parseados.
 */
export function parseNearbyQuery(
  c: Context<{ Bindings: Env }>,
): { lat: number; lon: number; radius: number } | Response {
  const latQuery = c.req.query('lat');
  const lonQuery = c.req.query('lon');
  const radiusQuery = c.req.query('radius');

  if (!latQuery || !lonQuery) {
    return c.json(
      {
        status: 'error',
        message: 'Se requieren los parámetros lat y lon',
        timestamp: new Date().toISOString(),
      },
      400,
    );
  }

  const lat = Number(latQuery);
  const lon = Number(lonQuery);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return c.json(
      {
        status: 'error',
        message: 'lat debe ser un número entre -90 y 90',
        timestamp: new Date().toISOString(),
      },
      400,
    );
  }

  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return c.json(
      {
        status: 'error',
        message: 'lon debe ser un número entre -180 y 180',
        timestamp: new Date().toISOString(),
      },
      400,
    );
  }

  let radius = NEARBY_CONFIG.DEFAULT_RADIUS_M;
  if (radiusQuery !== undefined) {
    radius = Number(radiusQuery);
    if (!Number.isFinite(radius) || radius <= 0 || radius > NEARBY_CONFIG.MAX_RADIUS_M) {
      return c.json(
        {
          status: 'error',
          message: `radius debe ser un número entre 1 y ${NEARBY_CONFIG.MAX_RADIUS_M} metros`,
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }
  }

  return { lat, lon, radius };
}

/**
 * Respuesta 200 compartida de los endpoints nearby (misma forma y mensajes en EMT y CRTM)
 */
export function nearbyResponse<T extends { distanceM: number }>(
  c: Context<{ Bindings: Env }>,
  query: { lat: number; lon: number; radius: number },
  results: T[],
): Response {
  return c.json(
    {
      status: 'success',
      message:
        results.length > 0
          ? `Se encontraron ${results.length} parada(s) en un radio de ${query.radius}m`
          : `No se encontraron paradas en un radio de ${query.radius}m`,
      data: {
        query,
        count: results.length,
        stops: results,
      },
      timestamp: new Date().toISOString(),
    },
    200,
    cacheableHeaders(),
  );
}
