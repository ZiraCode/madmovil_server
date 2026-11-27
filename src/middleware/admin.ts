import type { Context, Next } from 'hono';
import type { Env } from '../types';
import { secureEqual } from '../lib/secure-equal';

export async function adminAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const secret = c.env.ADMIN_SECRET;

  if (!secret) {
    return c.json(
      {
        status: 'error',
        message: 'Admin secret not configured',
        timestamp: new Date().toISOString(),
      },
      503,
    );
  }

  const provided = c.req.header('X-Admin-Secret');

  if (!provided || !secureEqual(provided, secret)) {
    return c.json(
      {
        status: 'error',
        message: 'Unauthorized',
        timestamp: new Date().toISOString(),
      },
      401,
    );
  }

  await next();
}
