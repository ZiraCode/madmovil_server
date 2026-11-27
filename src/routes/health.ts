import { Hono } from 'hono';
import type { Env, HealthResponse } from '../types';

const health = new Hono<{ Bindings: Env }>();

health.get('/', (c) => {
  const response: HealthResponse = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  };

  return c.json(response);
});

export { health };
