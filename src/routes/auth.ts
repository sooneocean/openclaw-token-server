import { Hono } from 'hono';
import type { Sql } from '../db/client';
import { AppError } from '../errors';
import { authMiddleware } from '../middleware/auth';
import { generateManagementKey } from '../utils/token';
import { hashPassword, verifyPassword } from '../utils/password';

export function authRoutes(sql: Sql) {
  const app = new Hono();

  // POST /auth/register
  app.post('/register', async (c) => {
    const body = await c.req.json();
    const { email, password } = body;

    if (!email || !password) {
      throw new AppError('INVALID_INPUT', 'Email and password are required', 400);
    }

    const passwordHash = await hashPassword(password);
    const managementKey = generateManagementKey();

    const result = await sql.begin(async (tx) => {
      // Check duplicate email
      const existing = await tx`SELECT id FROM users WHERE email = ${email}`;
      if (existing.length > 0) {
        throw new AppError('EMAIL_EXISTS', 'Email already registered', 409);
      }

      const [user] = await tx`
        INSERT INTO users (email, password_hash)
        VALUES (${email}, ${passwordHash})
        RETURNING id, email, created_at
      `;

      await tx`
        INSERT INTO management_keys (user_id, key_value)
        VALUES (${user.id}, ${managementKey})
      `;

      await tx`
        INSERT INTO credit_balances (user_id)
        VALUES (${user.id})
      `;

      return user;
    });

    return c.json({
      data: {
        management_key: managementKey,
        email: result.email,
        created_at: result.created_at.toISOString(),
      },
    }, 201);
  });

  // POST /auth/login
  app.post('/login', async (c) => {
    const body = await c.req.json();
    const { email, password } = body;

    if (!email || !password) {
      throw new AppError('INVALID_INPUT', 'Email and password are required', 400);
    }

    const users = await sql`
      SELECT id, email, password_hash FROM users WHERE email = ${email}
    `;

    if (users.length === 0 || !users[0].password_hash) {
      throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }

    const user = users[0];
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
    }

    const newKey = generateManagementKey();

    await sql.begin(async (tx) => {
      // Revoke all old keys
      await tx`
        UPDATE management_keys
        SET is_revoked = true, revoked_at = now()
        WHERE user_id = ${user.id} AND is_revoked = false
      `;

      await tx`
        INSERT INTO management_keys (user_id, key_value)
        VALUES (${user.id}, ${newKey})
      `;
    });

    return c.json({
      data: {
        management_key: newKey,
        email: user.email,
        last_login: new Date().toISOString(),
      },
    });
  });

  // GET /auth/me
  app.get('/me', authMiddleware(sql), async (c) => {
    const userId = c.get('userId');

    const [user] = await sql`
      SELECT u.email, u.plan, u.created_at,
             COALESCE(cb.total_credits, 0) - COALESCE(cb.total_usage, 0) AS credits_remaining,
             (SELECT COUNT(*)::int FROM provisioned_keys pk WHERE pk.user_id = u.id AND pk.is_revoked = false) AS keys_count
      FROM users u
      LEFT JOIN credit_balances cb ON cb.user_id = u.id
      WHERE u.id = ${userId}
    `;

    return c.json({
      data: {
        email: user.email,
        plan: user.plan,
        credits_remaining: Number(user.credits_remaining),
        keys_count: user.keys_count,
        created_at: user.created_at.toISOString(),
      },
    });
  });

  // POST /auth/rotate
  app.post('/rotate', authMiddleware(sql), async (c) => {
    const userId = c.get('userId');
    const newKey = generateManagementKey();

    const [user] = await sql.begin(async (tx) => {
      await tx`
        UPDATE management_keys
        SET is_revoked = true, revoked_at = now()
        WHERE user_id = ${userId} AND is_revoked = false
      `;

      await tx`
        INSERT INTO management_keys (user_id, key_value)
        VALUES (${userId}, ${newKey})
      `;

      return tx`SELECT email FROM users WHERE id = ${userId}`;
    });

    return c.json({
      data: {
        management_key: newKey,
        email: user.email,
        rotated_at: new Date().toISOString(),
      },
    });
  });

  return app;
}
