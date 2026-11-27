/**
 * Cabeceras de caché para respuestas cacheables (datos estáticos con TTL largo en KV)
 * max-age (navegador) deliberadamente menor que s-maxage (CDN): las correcciones llegan rápido al usuario
 * Nota: Vary: Origin lo añade el middleware CORS de Hono a todas las respuestas (obligatorio porque
 * la ACAO varía por origen; el CDN no debe servir respuestas entre orígenes distintos)
 */
export function cacheableHeaders(maxAgeSec = 300, sMaxAgeSec = 3600): Record<string, string> {
  return {
    'Cache-Control': `public, max-age=${maxAgeSec}, s-maxage=${sMaxAgeSec}`,
  };
}

/**
 * Cabeceras para respuestas en tiempo real (no se cachean en ningún sitio)
 */
export function noStoreHeaders(): Record<string, string> {
  return { 'Cache-Control': 'no-store' };
}
