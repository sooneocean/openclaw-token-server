import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Sql } from './db/client';
import { errorHandler } from './middleware/error';
import { authRoutes } from './routes/auth';
import { keysRoutes } from './routes/keys';
import { creditsRoutes } from './routes/credits';
import { oauthRoutes } from './routes/oauth';
import { proxyRoutes } from './routes/proxy';
import { webhookRoutes } from './routes/webhooks';

export function createApp(sql: Sql) {
  const app = new Hono();

  app.use('*', cors({ origin: '*' })); // TODO: restrict to known origins in production

  // Body size limit (1MB) — prevent DoS via oversized payloads
  app.use('*', async (c, next) => {
    const contentLength = c.req.header('content-length');
    if (contentLength && parseInt(contentLength, 10) > 1_048_576) {
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 1MB limit' } }, 413);
    }
    await next();
  });

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
  // Webhook routes（不需要 auth middleware，需要 raw body）
  app.route('/webhooks', webhookRoutes(sql));

  return app;
}
