import type { Context, Next } from 'hono';
import type { Sql } from '../db/client';
import { AppError } from '../errors';

export function authMiddleware(sql: Sql) {
  return async (c: Context, next: Next) => {
    const header = c.req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('UNAUTHORIZED', 'Missing or invalid authorization header', 401);
    }

    const token = header.slice(7);

    const rows = await sql`
      SELECT mk.user_id
      FROM management_keys mk
      WHERE mk.key_value = ${token} AND mk.is_revoked = false
    `;

    if (rows.length === 0) {
      throw new AppError('UNAUTHORIZED', 'Invalid or revoked token', 401);
    }

    c.set('userId', rows[0].user_id);
    await next();
  };
}
