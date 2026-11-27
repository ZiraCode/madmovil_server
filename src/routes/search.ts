import { Hono } from 'hono';
import type { Env } from '../types';
import { unifiedSearch } from '../lib/search';
import { emtStopIndex, crtmStopIndex } from '../lib/search-index';
import { loadArtifactFamilies } from '../lib/artifacts';
import { cacheableHeaders } from '../lib/cache-headers';
import { SEARCH_CONFIG } from '../lib/config';

const search = new Hono<{ Bindings: Env }>();

/**
 * GET /search?q=&lines=&stops=
 * Búsqueda unificada del buscador general de la web: líneas y paradas de todas las redes
 * (EMT bus + CRTM interurbano/urbano/ml/metro/cercanías) en una sola respuesta, servida
 * desde los artefactos de caché (lines:all + crtm:lines:all + stops:all + crtm:stops:all).
 *
 * Ranking en src/lib/search.ts: label exacto > prefijo > nombre (líneas);
 * código > nombre > dirección > municipio (paradas, dirección/municipio al final y capadas
 * para que el ruido de calles no domine). Query numérica = frontera de dígitos en paradas.
 *
 * - lines: nº máx de resultados de línea (default 5, máx 20)
 * - stops: nº máx de resultados de parada (default 8, máx 50)
 * - count devuelve siempre el total de coincidencias (pre-límite) por grupo
 * - Las paradas se filtran sobre índices normalizados memoizados junto al artefacto
 *   (src/lib/search-index.ts), no normalizeText por parada en cada request
 * - Degradación parcial: si una familia de artefactos falla (EMT caída / pipeline CRTM sin
 *   cargar), se sirve la otra con data.degraded; si fallan ambas → 503
 */
search.get('/', async (c) => {
  const rawQuery = (c.req.query('q') ?? '').trim();

  if (!rawQuery) {
    return c.json(
      {
        status: 'error',
        message: 'Se requiere el parámetro q (nombre o número de parada, o label/nombre de línea)',
        timestamp: new Date().toISOString(),
      },
      400,
    );
  }

  if (rawQuery.length > SEARCH_CONFIG.MAX_QUERY_CHARS) {
    return c.json(
      {
        status: 'error',
        message: `q debe tener como máximo ${SEARCH_CONFIG.MAX_QUERY_CHARS} caracteres`,
        timestamp: new Date().toISOString(),
      },
      400,
    );
  }

  let limitLines: number = SEARCH_CONFIG.LINES_DEFAULT_LIMIT;
  const linesQuery = c.req.query('lines');
  if (linesQuery !== undefined) {
    limitLines = Number(linesQuery);
    if (
      !Number.isInteger(limitLines) ||
      limitLines < 1 ||
      limitLines > SEARCH_CONFIG.LINES_MAX_LIMIT
    ) {
      return c.json(
        {
          status: 'error',
          message: `lines debe ser un entero entre 1 y ${SEARCH_CONFIG.LINES_MAX_LIMIT}`,
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }
  }

  let limitStops: number = SEARCH_CONFIG.STOPS_DEFAULT_LIMIT;
  const stopsQuery = c.req.query('stops');
  if (stopsQuery !== undefined) {
    limitStops = Number(stopsQuery);
    if (
      !Number.isInteger(limitStops) ||
      limitStops < 1 ||
      limitStops > SEARCH_CONFIG.STOPS_MAX_LIMIT
    ) {
      return c.json(
        {
          status: 'error',
          message: `stops debe ser un entero entre 1 y ${SEARCH_CONFIG.STOPS_MAX_LIMIT}`,
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }
  }

  // Las dos familias se leen en paralelo e independientes: una caída de la API EMT (raro,
  // solo en miss de caché) o del pipeline CRTM no tumba la búsqueda completa
  const families = await loadArtifactFamilies(c.env, 'Búsqueda unificada');

  if (families.degraded.length === 2) {
    return c.json(
      {
        status: 'error',
        message: 'Búsqueda no disponible ahora mismo (cachés EMT y CRTM inaccesibles)',
        timestamp: new Date().toISOString(),
      },
      503,
      { 'Retry-After': '60' },
    );
  }

  const result = unifiedSearch({
    query: rawQuery,
    emtLines: families.emtLines ?? [],
    crtmLines: families.crtmLines ?? [],
    emtStops: families.emtStops ? emtStopIndex(families.emtStops) : [],
    crtmStops: families.crtmStops ? crtmStopIndex(families.crtmStops) : [],
    limitLines,
    limitStops,
  });

  const total = result.lines.count + result.stops.count;

  return c.json(
    {
      status: 'success',
      message:
        total > 0
          ? `Se encontraron ${result.lines.count} línea(s) y ${result.stops.count} parada(s)`
          : 'No se encontraron resultados para la búsqueda',
      data: {
        query: rawQuery,
        lines: result.lines,
        stops: result.stops,
        ...(families.degraded.length > 0 ? { degraded: families.degraded } : {}),
      },
      timestamp: new Date().toISOString(),
    },
    200,
    cacheableHeaders(),
  );
});

export { search };
