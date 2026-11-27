import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { health } from './routes/health';
import { admin } from './routes/admin';
import { stops } from './routes/stops';
import { lines } from './routes/lines';
import { crtm } from './routes/crtm';
import { search } from './routes/search';
import { connections } from './routes/connections';
import { catalog } from './routes/catalog';
import favoritesVaultRoutes from './routes/favorites-vault';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { botFilterMiddleware } from './middleware/bot-filter';
import { FAVORITES_VAULT_CONFIG } from './lib/config';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

app.use(
  '*',
  cors({
    origin: (origin) => {
      // Sin header Origin (peticiones no-browser): no añadir cabecera CORS
      if (!origin) {
        return null;
      }

      // Permitir localhost en desarrollo (cualquier puerto)
      if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
        return origin;
      }

      // Orígenes de producción
      // (madmovil.com retirado de la allowlist hasta que el dominio sea nuestro: un origen
      // no controlado en la lista es un origen de confianza regalado a quien lo registre)
      if (['https://madmovil.es', 'https://www.madmovil.es'].includes(origin)) {
        return origin;
      }

      // Por defecto, rechazar (sin cabecera CORS)
      return null;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);

// El host workers.dev (público via certificados) solo expone /health para el smoke del CI:
// las protecciones anti-bots de la zone (api.madmovil.es) desafían a los runners de GitHub,
// así que el smoke pasa por aquí; el resto del API se sirve únicamente por el dominio propio
app.use('*', async (c, next) => {
  // Sin el punto final: el edge puede entregar el FQDN con trailing dot tal cual y el
  // endsWith('.workers.dev') lo dejaría pasar (verificado en vivo 2026-11-21)
  const host = new URL(c.req.url).hostname.replace(/\.$/, '');
  if (host.endsWith('.workers.dev') && c.req.path !== '/health') {
    return c.json(
      {
        status: 'error',
        message: 'Este host no sirve el API; usa https://api.madmovil.es',
        timestamp: new Date().toISOString(),
      },
      404,
    );
  }
  return next();
});

// Anti-scraping: peticiones sin User-Agent rechazadas en las familias de datos (el SSR de la web y los navegadores siempre envían UA)
app.use('/stops/*', botFilterMiddleware);
app.use('/lines/*', botFilterMiddleware);
app.use('/crtm/*', botFilterMiddleware);
app.use('/search/*', botFilterMiddleware);
app.use('/connections/*', botFilterMiddleware);
app.use('/catalog/*', botFilterMiddleware);

// Rate limiting sobre rutas que consultan la API EMT (60 req/min por IP y grupo).
// ssrBypass: el SSR de la propia web (X-SSR-Key válido) no consume unidades del limitador
// (sus fetch salen de pocas IPs de colo y compartían la clave grupo:ip consigo mismos);
// SOLO en las familias de datos — /admin/* y /api/favorites/* se limitan siempre
app.use('/stops/*', rateLimitMiddleware('stops', { ssrBypass: true }));
app.use('/lines/*', rateLimitMiddleware('lines', { ssrBypass: true }));
app.use('/crtm/*', rateLimitMiddleware('crtm', { ssrBypass: true }));
app.use('/search/*', rateLimitMiddleware('search', { ssrBypass: true }));
app.use('/connections/*', rateLimitMiddleware('connections', { ssrBypass: true }));
app.use('/catalog/*', rateLimitMiddleware('catalog', { ssrBypass: true }));
app.use('/admin/*', rateLimitMiddleware('admin'));

// Vault de favoritos (sincronización anónima cifrada E2E): bot-filter + rate limit del grupo vault
// y un límite extra (5/min) SOLO en la creación (POST) para frenar el llenado del KV además de Turnstile;
// respuestas privadas (llevan el blob de favoritos del portador del código secreto)
app.use('/api/favorites/*', botFilterMiddleware);
app.use('/api/favorites/*', rateLimitMiddleware('vault'));
app.use(
  '/api/favorites/vault',
  rateLimitMiddleware('vault-create', { methods: ['POST'], binding: 'VAULT_CREATE_LIMITER' }),
);
// Rechazo de bodies sobredimensionados ANTES de buffearlos (el check por caracteres del
// handler queda como segunda barrera): sin esto, un PUT sin Turnstile bufferea el body
// entero antes del 413
app.use(
  '/api/favorites/*',
  bodyLimit({
    maxSize: FAVORITES_VAULT_CONFIG.MAX_BODY_CHARS * 4,
    onError: (c) =>
      c.json(
        {
          status: 'error',
          message: `El cuerpo supera el tamaño máximo de ${FAVORITES_VAULT_CONFIG.MAX_BODY_CHARS} caracteres`,
          timestamp: new Date().toISOString(),
        },
        413,
      ),
  }),
);
app.use('/api/favorites/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
  c.header('Vary', 'Authorization');
});

// El worker solo sirve el API: robots.txt cerrado para crawlers (el robots de la web vive en madmovil_web)
app.get('/robots.txt', (c) => {
  return c.text('User-agent: *\nDisallow: /\n');
});

// Contrato de respuesta también fuera de los handlers: 404 de rutas inexistentes y
// excepciones no capturadas (search/catalog/connections no tienen try/catch) salen con
// el envelope {status:'error'} y dejan rastro en logs, no como texto plano de Hono
app.notFound((c) =>
  c.json(
    {
      status: 'error',
      message: 'Ruta no encontrada',
      timestamp: new Date().toISOString(),
    },
    404,
  ),
);

app.onError((err, c) => {
  console.error(`${c.req.method} ${c.req.path} sin capturar:`, err);
  return c.json(
    {
      status: 'error',
      message: 'Error interno del servidor',
      timestamp: new Date().toISOString(),
    },
    500,
  );
});

// Rutas públicas (sin autenticación)
app.route('/health', health);
app.route('/admin', admin);
app.route('/stops', stops);
app.route('/lines', lines);
app.route('/crtm', crtm);
app.route('/search', search);
app.route('/connections', connections);
app.route('/catalog', catalog);

// Vault de favoritos (autorización por código secreto derivado, sin cuentas)
app.route('/api/favorites', favoritesVaultRoutes);

export default app;
