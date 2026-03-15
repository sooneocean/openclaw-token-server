import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Sql } from './db/client';
import { errorHandler } from './middleware/error';
import { authRoutes } from './routes/auth';
import { keysRoutes } from './routes/keys';
import { creditsRoutes } from './routes/credits';
import { oauthRoutes } from './routes/oauth';
import { proxyRoutes } from './routes/proxy';

export function createApp(sql: Sql) {
  const app = new Hono();

  app.use('*', cors());

  // Security headers
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    c.header('X-Request-Id', crypto.randomUUID());
  });

  app.onError(errorHandler);

  app.get('/', (c) => c.json({ status: 'ok' }));

  app.route('/auth', authRoutes(sql));
  app.route('/keys', keysRoutes(sql));
  app.route('/credits', creditsRoutes(sql));
  app.route('/oauth', oauthRoutes(sql));
  // Proxy endpoint：使用 provisioned key 轉發 LLM API 請求
  app.route('/v1', proxyRoutes(sql));

  return app;
}
