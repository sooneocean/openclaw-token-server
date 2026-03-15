import { Hono } from 'hono';
import type { Sql } from '../db/client';
import { config } from '../config';
import { getStripe, isStripeEnabled } from '../utils/stripe';

export function webhookRoutes(sql: Sql) {
  const app = new Hono();

  app.post('/stripe', async (c) => {
    if (!isStripeEnabled()) {
      return c.json({ error: 'Stripe not configured' }, 400);
    }

    const stripe = getStripe()!;
    const sig = c.req.header('stripe-signature');
    if (!sig) {
      return c.json({ error: 'Missing signature' }, 400);
    }

    const rawBody = await c.req.text();

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, config.stripeWebhookSecret);
    } catch (err) {
      return c.json({ error: 'Invalid signature' }, 400);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.user_id;
      const creditAmount = Number(session.metadata?.credit_amount || 0);
      const idempotencyKey = session.metadata?.idempotency_key || null;

      if (!userId || creditAmount <= 0) {
        return c.json({ received: true }); // ignore invalid
      }

      // Idempotency: check if already processed
      if (idempotencyKey) {
        const existing = await sql`
          SELECT id FROM credit_transactions
          WHERE idempotency_key = ${idempotencyKey}
          AND created_at > now() - interval '24 hours'
        `;
        if (existing.length > 0) {
          return c.json({ received: true }); // already processed
        }
      }

      // Add credits
      await sql.begin(async (tx) => {
        await tx`
          UPDATE credit_balances
          SET total_credits = total_credits + ${creditAmount}, updated_at = now()
          WHERE user_id = ${userId}::uuid
        `;

        const [balance] = await tx`
          SELECT total_credits, total_usage FROM credit_balances WHERE user_id = ${userId}::uuid
        `;
        const newBalance = Number(balance.total_credits) - Number(balance.total_usage);

        await tx`
          INSERT INTO credit_transactions (user_id, type, amount, balance_after, description, idempotency_key)
          VALUES (${userId}::uuid, 'purchase', ${creditAmount}, ${newBalance},
                  ${'Stripe payment: ' + session.id}, ${idempotencyKey})
        `;
      });
    }

    return c.json({ received: true });
  });

  return app;
}
