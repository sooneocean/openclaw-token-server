import { Hono } from 'hono';
import type { Sql } from '../db/client';
import { AppError } from '../errors';
import { authMiddleware } from '../middleware/auth';
import { generateTransactionId } from '../utils/token';

export function creditsRoutes(sql: Sql) {
  const app = new Hono();

  app.use('*', authMiddleware(sql));

  // GET /credits
  app.get('/', async (c) => {
    const userId = c.get('userId');

    const [balance] = await sql`
      SELECT total_credits, total_usage
      FROM credit_balances WHERE user_id = ${userId}
    `;

    return c.json({
      data: {
        total_credits: Number(balance.total_credits),
        total_usage: Number(balance.total_usage),
        remaining: Number(balance.total_credits) - Number(balance.total_usage),
      },
    });
  });

  // POST /credits/purchase
  app.post('/purchase', async (c) => {
    const userId = c.get('userId');
    const body = await c.req.json();
    const { amount } = body;

    if (!amount || amount < 5) {
      throw new AppError('INVALID_INPUT', 'Amount must be at least 5', 400);
    }

    const idempotencyKey = c.req.header('Idempotency-Key') || c.req.header('idempotency-key') || null;

    // Check idempotency
    if (idempotencyKey) {
      const existing = await sql`
        SELECT id, amount, balance_after, created_at
        FROM credit_transactions
        WHERE idempotency_key = ${idempotencyKey}
          AND created_at > now() - interval '24 hours'
      `;
      if (existing.length > 0) {
        const tx = existing[0];
        const platformFee = Math.round(Math.max(Number(amount) * 0.055, 0.80) * 100) / 100;
        return c.json({
          data: {
            transaction_id: tx.id,
            amount: Number(amount),
            platform_fee: platformFee,
            total_charged: Number(amount) + platformFee,
            new_balance: Number(tx.balance_after),
            created_at: tx.created_at.toISOString(),
          },
        });
      }
    }

    const platformFee = Math.round(Math.max(Number(amount) * 0.055, 0.80) * 100) / 100;

    const result = await sql.begin(async (tx) => {
      const [updated] = await tx`
        UPDATE credit_balances
        SET total_credits = total_credits + ${amount}, updated_at = now()
        WHERE user_id = ${userId}
        RETURNING total_credits, total_usage
      `;

      const newBalance = Number(updated.total_credits) - Number(updated.total_usage);

      const [inserted] = await tx`
        INSERT INTO credit_transactions (user_id, type, amount, balance_after, description, idempotency_key)
        VALUES (${userId}, 'purchase', ${amount}, ${newBalance}, 'Credit purchase', ${idempotencyKey})
        RETURNING id, created_at
      `;

      return { id: inserted.id, newBalance, created_at: inserted.created_at.toISOString() };
    });

    return c.json({
      data: {
        transaction_id: result.id,
        amount: Number(amount),
        platform_fee: platformFee,
        total_charged: Number(amount) + platformFee,
        new_balance: result.newBalance,
        created_at: result.created_at,
      },
    });
  });

  // GET /credits/history
  app.get('/history', async (c) => {
    const userId = c.get('userId');
    const limit = parseInt(c.req.query('limit') || '20', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);
    const type = c.req.query('type');

    const condition = type
      ? sql`user_id = ${userId} AND type = ${type}`
      : sql`user_id = ${userId}`;

    const items = await sql`
      SELECT id, type, amount, balance_after, description, created_at
      FROM credit_transactions
      WHERE ${condition}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count
      FROM credit_transactions
      WHERE ${condition}
    `;

    return c.json({
      data: {
        items: items.map((t: any) => ({
          id: t.id,
          type: t.type,
          amount: Number(t.amount),
          balance_after: Number(t.balance_after),
          description: t.description,
          created_at: t.created_at.toISOString(),
        })),
        total: count,
        limit,
        offset,
        has_more: offset + limit < count,
      },
    });
  });

  // GET /credits/auto-topup
  app.get('/auto-topup', async (c) => {
    const userId = c.get('userId');

    const [config] = await sql`
      SELECT auto_topup_enabled, auto_topup_threshold, auto_topup_amount
      FROM credit_balances WHERE user_id = ${userId}
    `;

    return c.json({
      data: {
        enabled: config.auto_topup_enabled,
        threshold: Number(config.auto_topup_threshold),
        amount: Number(config.auto_topup_amount),
      },
    });
  });

  // PUT /credits/auto-topup
  app.put('/auto-topup', async (c) => {
    const userId = c.get('userId');
    const body = await c.req.json();

    if ('threshold' in body && body.threshold < 1) {
      throw new AppError('INVALID_INPUT', 'Threshold must be at least 1', 400);
    }
    if ('amount' in body && body.amount < 5) {
      throw new AppError('INVALID_INPUT', 'Amount must be at least 5', 400);
    }

    const updates: Record<string, any> = {};
    if ('enabled' in body) updates.auto_topup_enabled = body.enabled;
    if ('threshold' in body) updates.auto_topup_threshold = body.threshold;
    if ('amount' in body) updates.auto_topup_amount = body.amount;
    updates.updated_at = sql`now()`;

    const [updated] = await sql`
      UPDATE credit_balances
      SET ${sql(updates)}
      WHERE user_id = ${userId}
      RETURNING auto_topup_enabled, auto_topup_threshold, auto_topup_amount, updated_at
    `;

    return c.json({
      data: {
        enabled: updated.auto_topup_enabled,
        threshold: Number(updated.auto_topup_threshold),
        amount: Number(updated.auto_topup_amount),
        updated_at: updated.updated_at.toISOString(),
      },
    });
  });

  return app;
}
