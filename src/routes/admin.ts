import { Hono } from 'hono';
import type { Env } from '../types';
import { refreshAllCache } from '../lib/emt-cache';
import { adminAuthMiddleware } from '../middleware/admin';

const admin = new Hono<{ Bindings: Env }>();

admin.use('*', adminAuthMiddleware);

admin.post('/refresh-cache', async (c) => {
  try {
    const startTime = Date.now();

    // Obtener el año opcional del query parameter
    const yearParam = c.req.query('year');
    let year: number | undefined;
    if (yearParam !== undefined) {
      year = Number(yearParam);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return c.json(
          {
            status: 'error',
            message: 'Invalid year parameter. Must be between 2000 and 2100',
            timestamp: new Date().toISOString(),
          },
          400,
        );
      }
    }

    const result = await refreshAllCache(c.env, year);
    const duration = Date.now() - startTime;

    return c.json({
      status: 'success',
      message: 'Cache refreshed successfully',
      data: {
        stops: result.stops,
        lines: result.lines,
        calendar: result.calendar,
        year: year || new Date().getFullYear(),
        durationMs: duration,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Cache refresh failed:', error);
    return c.json(
      {
        status: 'error',
        message: 'Cache refresh failed',
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
});

export { admin };
