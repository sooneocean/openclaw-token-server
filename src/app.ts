import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Sql } from './db/client';
import { errorHandler } from './middleware/error';
import { authRoutes } from './routes/auth';
import { keysRoutes } from './routes/keys';
import { creditsRoutes } from './routes/credits';
import { oauthRoutes } from './routes/oauth';

export function createApp(sql: Sql) {
  const app = new Hono();

  app.use('*', cors());
  app.onError(errorHandler);

  app.get('/', (c) => c.json({ status: 'ok' }));

  app.route('/auth', authRoutes(sql));
  app.route('/keys', keysRoutes(sql));
  app.route('/credits', creditsRoutes(sql));
  app.route('/oauth', oauthRoutes(sql));

  return app;
}
