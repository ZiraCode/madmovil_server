import { Hono } from 'hono';
import type { Env } from '../types';
import { findStopConnections } from '../lib/connections';
import { loadArtifactFamilies } from '../lib/artifacts';
import { cacheableHeaders } from '../lib/cache-headers';
import { CONNECTIONS_CONFIG, CRTM_PATTERNS } from '../lib/config';

const connections = new Hono<{ Bindings: Env }>();

/**
 * GET /connections/:source/:stopId?radius=
 * Transbordos de una parada: líneas de OTRAS paradas físicas en un radio a pie (default 300,
 * máx 500 m). Los intercambiadores son N paradas con códigos distintos (EMT 602 + CRTM 06002
 * + metro 4_202 + cercanías r_*): este endpoint las mezcla y deduplica.
 *
 * - :source = emt | crtm (desambigua códigos numéricos que existen en ambas familias)
 * - Lógica pura en src/lib/connections.ts: haversine sobre stops:all EMT+CRTM (memoizados),
 *   dedup por red+label (las líneas de la propia parada no son transbordo), grupos por red
 *   con la distancia de la parada más cercana y refs de línea como las de /search (chips)
 * - Degradación parcial como /search: si falla una familia (stops o lines), se sirve la otra
 *   con data.degraded; sin el stops:all de la familia del ORIGEN no hay respuesta → 503
 * - Cero llamadas externas; Cache-Control 300/3600; rate limit grupo connections + bot-filter
 */
connections.get('/:source/:stopId', async (c) => {
  const source = c.req.param('source');
  if (source !== 'emt' && source !== 'crtm') {
    return c.json(
      {
        status: 'error',
        message: 'source debe ser emt o crtm',
        timestamp: new Date().toISOString(),
      },
      400,
    );
  }

  const stopId = c.req.param('stopId');
  const stopIdValid =
    source === 'emt' ? /^\d+$/.test(stopId) : CRTM_PATTERNS.STOP_CODE.test(stopId);
  if (!stopIdValid) {
    return c.json(
      {
        status: 'error',
        message:
          source === 'emt'
            ? 'stopId debe ser numérico'
            : 'stopId inválido (código CRTM: bus numérico, 4_*, 10_* o r_*)',
        timestamp: new Date().toISOString(),
      },
      400,
    );
  }

  let radiusM: number = CONNECTIONS_CONFIG.RADIUS_DEFAULT_M;
  const radiusQuery = c.req.query('radius');
  if (radiusQuery !== undefined) {
    radiusM = Number(radiusQuery);
    if (!Number.isFinite(radiusM) || radiusM <= 0 || radiusM > CONNECTIONS_CONFIG.RADIUS_MAX_M) {
      return c.json(
        {
          status: 'error',
          message: `radius debe ser un número entre 1 y ${CONNECTIONS_CONFIG.RADIUS_MAX_M} metros`,
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }
  }

  const families = await loadArtifactFamilies(c.env, 'Conexiones');

  // Sin el listado de paradas de la familia del origen no hay respuesta posible (ni 404 fiable):
  // la otra familia caída no es 503, se sirve lo que haya con degraded
  const originStops = source === 'emt' ? families.emtStops : families.crtmStops;
  if (originStops === null) {
    return c.json(
      {
        status: 'error',
        message: 'Conexiones no disponibles ahora mismo (listado de paradas inaccesible)',
        timestamp: new Date().toISOString(),
      },
      503,
      { 'Retry-After': '60' },
    );
  }

  const result = findStopConnections({
    source,
    stopId,
    radiusM,
    emtStops: families.emtStops,
    emtLines: families.emtLines,
    crtmStops: families.crtmStops,
    crtmLines: families.crtmLines,
  });

  if (!result) {
    return c.json(
      {
        status: 'error',
        message: `No existe la parada ${source === 'emt' ? 'EMT' : 'CRTM'} ${stopId}`,
        timestamp: new Date().toISOString(),
      },
      404,
    );
  }

  return c.json(
    {
      status: 'success',
      message:
        result.transferCount > 0
          ? `${result.transferCount} línea(s) de transbordo en ${result.stops.length} parada(s) a menos de ${radiusM} m`
          : `Sin líneas de transbordo a menos de ${radiusM} m`,
      data: {
        query: result.origin,
        radiusM,
        stops: result.stops,
        transfers: { count: result.transferCount, groups: result.groups },
        ...(families.degraded.length > 0 ? { degraded: families.degraded } : {}),
      },
      timestamp: new Date().toISOString(),
    },
    200,
    cacheableHeaders(),
  );
});

export { connections };
