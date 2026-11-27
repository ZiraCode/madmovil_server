import { Hono } from 'hono';
import type { Env } from '../types';
import { getCRTMMeta } from '../lib/crtm-cache';
import { loadArtifactFamilies } from '../lib/artifacts';
import { cacheableHeaders } from '../lib/cache-headers';

const catalog = new Hono<{ Bindings: Env }>();

/**
 * GET /catalog
 * Catálogo de URLs indexables para los sitemaps de la web (madmovil_web genera
 * sitemap-lineas/sitemap-paradas-emt/sitemap-paradas-crtm a partir de esta respuesta):
 * labels de líneas EMT (la URL de ficha es /linea/{label}, único dentro de la EMT),
 * pares label/routeId de líneas CRTM (la ficha va por routeId, único entre redes),
 * stopIds EMT y códigos CRTM (incluidos 4_/10_/r_). Solo identificadores: los nombres
 * ya viajan en cada ficha SSR.
 *
 * Servido al 100% desde los artefactos memoizados (mismo patrón que /search): una
 * familia caída se omite con data.degraded y la otra se sirve igual; si fallan ambas → 503.
 * crtm.generatedAt (crtm:meta) sirve de lastmod para los sitemaps CRTM.
 */
catalog.get('/', async (c) => {
  // crtm:meta (quinta familia) se pide aparte en paralelo al helper: NO computa para degraded
  // ni provoca 503 — si falla, generatedAt sale null (catch inmediato: nunca queda sin manejar)
  const metaPromise = getCRTMMeta(c.env).catch(() => null);
  const families = await loadArtifactFamilies(c.env, 'Catálogo');

  if (families.degraded.length === 2) {
    return c.json(
      {
        status: 'error',
        message: 'Catálogo no disponible ahora mismo (cachés EMT y CRTM inaccesibles)',
        timestamp: new Date().toISOString(),
      },
      503,
      { 'Retry-After': '60' },
    );
  }

  const emtLineLabels = families.emtLines?.map((line) => line.label) ?? [];
  const emtStopIds = families.emtStops?.map((stop) => stop.stopId) ?? [];
  const crtmLineRefs =
    families.crtmLines?.map((line) => ({ label: line.label, routeId: line.routeId })) ?? [];
  const crtmStopCodes = families.crtmStops?.map((stop) => stop.code) ?? [];

  return c.json(
    {
      status: 'success',
      message: `Catálogo: ${emtLineLabels.length + crtmLineRefs.length} línea(s) y ${emtStopIds.length + crtmStopCodes.length} parada(s)`,
      data: {
        emt: {
          lines: emtLineLabels,
          stops: emtStopIds,
        },
        crtm: {
          lines: crtmLineRefs,
          stops: crtmStopCodes,
          generatedAt: (await metaPromise)?.generatedAt ?? null,
        },
        ...(families.degraded.length > 0 ? { degraded: families.degraded } : {}),
      },
      timestamp: new Date().toISOString(),
    },
    200,
    cacheableHeaders(),
  );
});

export { catalog };
