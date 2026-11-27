import { Hono } from 'hono';
import type { Env } from '../types';
import type { Line } from '../types/emt-data';
import {
  getCachedLines,
  getCachedLineDetail,
  getCachedLineTimetable,
  getCachedLineRoute,
  getLineIncidents,
  LineNotFoundError,
} from '../lib/emt-cache';
import { cacheableHeaders } from '../lib/cache-headers';
import { normalizeText } from '../lib/text-utils';
import { dateWithinWindow } from '../lib/date-utils';
import { EMT_CONFIG } from '../lib/config';

const lines = new Hono<{ Bindings: Env }>();

/**
 * Endpoint de listado de todas las líneas
 * Devuelve label, cabeceras (nameA/nameB), group y color desde el caché lines:all,
 * pensado para pintar la lista de líneas (chips) del frontend
 */
lines.get('/', async (c) => {
  try {
    const allLines = await getCachedLines(c.env);

    return c.json(
      {
        status: 'success',
        message: `Se encontraron ${allLines.length} línea(s)`,
        data: {
          count: allLines.length,
          lines: allLines,
        },
        timestamp: new Date().toISOString(),
      },
      200,
      cacheableHeaders(),
    );
  } catch (error) {
    console.error('GET /lines falló:', error);
    return c.json(
      {
        status: 'error',
        message: 'Error al obtener las líneas',
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
});

/**
 * Endpoint de detalles de línea
 * Obtiene información detallada de una línea incluyendo horarios (timeTable)
 *
 * Params:
 * - lineId: ID de la línea (en la ruta)
 *
 * Query params (opcional):
 * - date: Fecha en formato YYYYMMDD (ej: 20251123). Si no se proporciona, usa la fecha actual
 *
 * Ejemplos:
 * - /detail/001
 * - /detail/001?date=20251123
 * - /detail/068?date=20251201
 */
lines.get('/detail/:lineId', async (c) => {
  try {
    const lineId = c.req.param('lineId');
    const dateQuery = c.req.query('date'); // Formato YYYYMMDD

    if (!/^\d+$/.test(lineId)) {
      return c.json(
        {
          status: 'error',
          message: 'lineId debe ser numérico',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    // Validar formato de fecha si se proporciona
    if (dateQuery && !/^\d{8}$/.test(dateQuery)) {
      return c.json(
        {
          status: 'error',
          message: 'El formato de fecha debe ser YYYYMMDD (ej: 20251123)',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    // Acota el rango de fechas consultables (limita el espacio de claves de caché)
    if (dateQuery && !dateWithinWindow(dateQuery, -7, 30)) {
      return c.json(
        {
          status: 'error',
          message: 'date debe estar entre 7 días atrás y 30 días por delante',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    const lineDetail = await getCachedLineDetail(c.env, lineId, dateQuery);

    return c.json(
      {
        status: 'success',
        message: 'Detalles de línea recuperados correctamente',
        data: lineDetail,
        timestamp: new Date().toISOString(),
      },
      200,
      cacheableHeaders(),
    );
  } catch (error) {
    if (error instanceof LineNotFoundError) {
      return c.json(
        {
          status: 'error',
          message: error.message,
          timestamp: new Date().toISOString(),
        },
        404,
      );
    }
    console.error('GET /lines/detail falló:', error);
    return c.json(
      {
        status: 'error',
        message: 'Error al obtener detalles de línea',
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
});

/**
 * Endpoint de horarios de línea por tipo de día
 * Devuelve primero/último servicio y frecuencias por dirección y tipo de día (laboral/sabado/festivo)
 *
 * Params:
 * - lineId: ID de la línea (en la ruta)
 *
 * Ejemplos:
 * - /timetable/001
 * - /timetable/068
 */
lines.get('/timetable/:lineId', async (c) => {
  try {
    const lineId = c.req.param('lineId');

    if (!/^\d+$/.test(lineId)) {
      return c.json(
        {
          status: 'error',
          message: 'lineId debe ser numérico',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    const timetable = await getCachedLineTimetable(c.env, lineId);

    return c.json(
      {
        status: 'success',
        message: 'Horarios de línea recuperados correctamente',
        data: {
          lineId: timetable.lineId,
          dayTypes: Object.keys(timetable.schedules),
          schedules: timetable.schedules,
        },
        timestamp: new Date().toISOString(),
      },
      200,
      cacheableHeaders(),
    );
  } catch (error) {
    if (error instanceof LineNotFoundError) {
      return c.json(
        {
          status: 'error',
          message: error.message,
          timestamp: new Date().toISOString(),
        },
        404,
      );
    }
    console.error('GET /lines/timetable falló:', error);
    return c.json(
      {
        status: 'error',
        message: 'Error al obtener horarios de línea',
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
});

/**
 * Endpoint de ruta de línea (geometría GeoJSON)
 * Devuelve itinerario (MultiLineString por tramo) y paradas (Point) por dirección,
 * listo para pintar en mapa (Leaflet/Mapbox consumen GeoJSON directo)
 *
 * Params:
 * - label: Label público de la línea (número, ej: 1, 27, 001)
 *
 * Ejemplos:
 * - /route/1
 * - /route/27
 */
lines.get('/route/:label', async (c) => {
  try {
    const label = c.req.param('label');

    if (!/^[A-Za-z0-9]+$/.test(label)) {
      return c.json(
        {
          status: 'error',
          message: 'label inválido (solo caracteres alfanuméricos)',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    const route = await getCachedLineRoute(c.env, label);

    return c.json(
      {
        status: 'success',
        message: 'Ruta de línea recuperada correctamente',
        data: route,
        timestamp: new Date().toISOString(),
      },
      200,
      cacheableHeaders(),
    );
  } catch (error) {
    if (error instanceof LineNotFoundError) {
      return c.json(
        {
          status: 'error',
          message: error.message,
          timestamp: new Date().toISOString(),
        },
        404,
      );
    }
    console.error('GET /lines/route falló:', error);
    return c.json(
      {
        status: 'error',
        message: 'Error al obtener la ruta de línea',
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
});

/**
 * Endpoint de incidencias por línea
 * Devuelve los avisos vigentes (activos o próximos) que afectan a una línea;
 * el feed completo se cachea una vez y se filtra localmente por label
 *
 * Params:
 * - label: Label público de la línea (ej: 5, N13, M1) o 'all' para todas
 *
 * Ejemplos:
 * - /incidents/5
 * - /incidents/N13
 * - /incidents/all
 */
lines.get('/incidents/:label', async (c) => {
  try {
    const label = c.req.param('label');

    if (label !== 'all' && !/^[A-Za-z0-9]+$/.test(label)) {
      return c.json(
        {
          status: 'error',
          message: 'label inválido (solo caracteres alfanuméricos)',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    const feed = await getLineIncidents(c.env, label);

    return c.json(
      {
        status: 'success',
        message:
          feed.incidents.length > 0
            ? `Se encontraron ${feed.incidents.length} incidencia(s)`
            : 'No hay incidencias vigentes para esta búsqueda',
        data: {
          label,
          count: feed.incidents.length,
          lastBuildDate: feed.lastBuildDate,
          incidents: feed.incidents,
        },
        timestamp: new Date().toISOString(),
      },
      200,
      cacheableHeaders(300, EMT_CONFIG.INCIDENTS_TTL),
    );
  } catch (error) {
    console.error('GET /lines/incidents falló:', error);
    return c.json(
      {
        status: 'error',
        message: 'Error al obtener incidencias',
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
});

/**
 * Endpoint de búsqueda de líneas
 * Busca por label (exacto) o por nameA/nameB (parcial, insensible a mayúsculas/acentos)
 *
 * Query params:
 * - label: Busca por etiqueta de línea (exacto)
 * - name: Busca por nombre de línea en nameA o nameB (parcial, normalizado)
 *
 * Ejemplos:
 * - /search?label=1
 * - /search?name=atocha
 * - /search?name=plaza españa
 */
lines.get('/search', async (c) => {
  try {
    const labelQuery = c.req.query('label');
    const nameQuery = c.req.query('name');

    // Validar que al menos uno de los parámetros esté presente
    if (!labelQuery && !nameQuery) {
      return c.json(
        {
          status: 'error',
          message: 'Se requiere al menos uno de los parámetros: label o name',
          timestamp: new Date().toISOString(),
        },
        400,
      );
    }

    // Query que normaliza a vacío: includes('') matchearía TODAS las líneas
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

    // Obtener todas las líneas del caché
    const allLines = await getCachedLines(c.env);

    let results: Line[] = [];

    // Búsqueda por label (exacta)
    if (labelQuery) {
      const line = allLines.find((l) => l.label === labelQuery);
      if (line) {
        results = [line];
      }
    }
    // Búsqueda por nombre (parcial, normalizada en nameA o nameB)
    else if (nameQuery) {
      const normalizedQuery = normalizeText(nameQuery);

      results = allLines.filter((line) => {
        const normalizedNameA = normalizeText(line.nameA);
        const normalizedNameB = normalizeText(line.nameB);

        return (
          normalizedNameA.includes(normalizedQuery) || normalizedNameB.includes(normalizedQuery)
        );
      });
    }

    return c.json(
      {
        status: 'success',
        message:
          results.length > 0
            ? `Se encontraron ${results.length} línea(s)`
            : 'No se encontraron líneas que coincidan con la búsqueda',
        data: {
          query: {
            label: labelQuery || null,
            name: nameQuery || null,
          },
          count: results.length,
          lines: results,
        },
        timestamp: new Date().toISOString(),
      },
      200,
      cacheableHeaders(),
    );
  } catch (error) {
    console.error('GET /lines/search falló:', error);
    return c.json(
      {
        status: 'error',
        message: 'Error al buscar líneas',
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
});

export { lines };
