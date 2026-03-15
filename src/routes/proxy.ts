import { Hono } from 'hono';
import type { Sql } from '../db/client';
import { config } from '../config';
import { AppError } from '../errors';
import { proxyAuthMiddleware } from '../middleware/proxy-auth';
import { calculateCost } from '../utils/pricing';
import { recordUsage } from '../utils/usage';
import { createSSEUsageExtractor } from '../utils/sse-parser';

export function proxyRoutes(sql: Sql) {
  const proxy = new Hono();

  // 套用 provisioned key 驗證 middleware
  proxy.use('/*', proxyAuthMiddleware(sql));

  // POST /chat/completions — OpenAI-compatible proxy endpoint
  proxy.post('/chat/completions', async (c) => {
    const userId = c.get('userId') as string;
    const keyId = c.get('keyId') as string;

    // 解析 request body
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError('INVALID_INPUT', 'Invalid JSON body', 400);
    }

    // model 是必填欄位
    const model = body.model as string | undefined;
    if (!model) {
      throw new AppError('INVALID_INPUT', 'model is required', 400);
    }

    const isStreaming = body.stream === true;

    // 預檢帳戶 credits + auto-topup 觸發
    const balanceRows = await sql`
      SELECT total_credits, total_usage, auto_topup_enabled, auto_topup_threshold, auto_topup_amount
      FROM credit_balances
      WHERE user_id = ${userId}::uuid
    `;

    if (balanceRows.length === 0) {
      throw new AppError('INSUFFICIENT_CREDITS', 'Insufficient credits', 402);
    }

    const balance = balanceRows[0];
    let remaining = Number(balance.total_credits) - Number(balance.total_usage);

    // Auto-topup：餘額低於 threshold 時自動加 credits
    // NOTE: 目前為 placeholder — 直接加值，未來應整合 Stripe saved payment method
    if (balance.auto_topup_enabled && remaining <= Number(balance.auto_topup_threshold)) {
      const topupAmount = Number(balance.auto_topup_amount);
      await sql.begin(async (tx) => {
        const [locked] = await tx`
          SELECT total_credits, total_usage FROM credit_balances
          WHERE user_id = ${userId}::uuid FOR UPDATE
        `;
        const lockedRemaining = Number(locked.total_credits) - Number(locked.total_usage);
        if (lockedRemaining <= Number(balance.auto_topup_threshold)) {
          await tx`
            UPDATE credit_balances
            SET total_credits = total_credits + ${topupAmount}, updated_at = now()
            WHERE user_id = ${userId}::uuid
          `;
          await tx`
            INSERT INTO credit_transactions (user_id, type, amount, balance_after, description)
            VALUES (${userId}::uuid, 'auto_topup', ${topupAmount}, ${lockedRemaining + topupAmount}, 'Auto top-up (placeholder — no payment)')
          `;
          remaining = lockedRemaining + topupAmount;
          console.log(`[proxy] Auto-topup triggered for user ${userId}: +$${topupAmount} (placeholder)`);
        } else {
          remaining = lockedRemaining;
        }
      });
    }

    if (remaining <= 0) {
      throw new AppError('INSUFFICIENT_CREDITS', 'Insufficient credits', 402);
    }

    // Streaming: 注入 stream_options.include_usage 讓上游回傳 usage chunk
    if (isStreaming) {
      body.stream_options = { ...(body.stream_options as Record<string, unknown> || {}), include_usage: true };
    }

    // 轉發到上游 LLM API
    const upstreamUrl = `${config.upstreamApiBase}/v1/chat/completions`;

    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.upstreamApiKey}`,
        },
        body: JSON.stringify(body),
        signal: isStreaming ? c.req.raw.signal : undefined,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // Client 斷線，不 recordUsage
        return new Response(null, { status: 499 });
      }
      throw new AppError('UPSTREAM_UNREACHABLE', `Upstream LLM unreachable: ${(err as Error).message}`, 502);
    }

    // ── Streaming 分支 ──────────────────────────────────────────────────
    if (isStreaming) {
      // 上游非 2xx → 走 non-streaming 錯誤路徑
      if (!upstreamResp.ok) {
        let errorBody: unknown;
        try { errorBody = await upstreamResp.json(); } catch { errorBody = { error: { message: 'Upstream error' } }; }
        try {
          await recordUsage(sql, { userId, keyId, model, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, upstreamStatus: upstreamResp.status });
        } catch (err) { console.error('[proxy] recordUsage failed after upstream error:', err); }
        return c.json(errorBody, upstreamResp.status as any);
      }

      // 上游非 SSE → 降級為 non-streaming
      const contentType = upstreamResp.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream') && !upstreamResp.body) {
        let respBody: unknown;
        try { respBody = await upstreamResp.json(); } catch { respBody = { error: { message: 'Upstream returned non-SSE response' } }; }
        return c.json(respBody, upstreamResp.status as any);
      }

      // SSE streaming proxy
      const extractor = createSSEUsageExtractor();
      const transformedStream = upstreamResp.body!.pipeThrough(extractor.transformStream);

      // 在 stream 被完全消費後記錄 usage
      const trackingStream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
        },
        async flush() {
          const usage = extractor.getUsage();
          const promptTokens = usage?.prompt_tokens ?? 0;
          const completionTokens = usage?.completion_tokens ?? 0;
          const totalTokens = usage?.total_tokens ?? 0;
          const cost = calculateCost(model, promptTokens, completionTokens);
          try {
            await recordUsage(sql, { userId, keyId, model, promptTokens, completionTokens, totalTokens, cost, upstreamStatus: upstreamResp.status });
          } catch (err) {
            console.error('[proxy] recordUsage failed after streaming:', err);
          }
        },
      });

      const finalStream = transformedStream.pipeThrough(trackingStream);

      return new Response(finalStream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // ── Non-streaming 分支（原有邏輯不變）────────────────────────────────

    // 讀取上游 response body
    let respBody: unknown;
    try {
      respBody = await upstreamResp.json();
    } catch {
      respBody = { error: { message: 'Upstream returned non-JSON response' } };
    }

    if (upstreamResp.ok) {
      const usage = (respBody as any)?.usage ?? {};
      const promptTokens = Number(usage.prompt_tokens ?? 0);
      const completionTokens = Number(usage.completion_tokens ?? 0);
      const totalTokens = Number(usage.total_tokens ?? 0);
      const cost = calculateCost(model, promptTokens, completionTokens);

      await recordUsage(sql, {
        userId, keyId, model, promptTokens, completionTokens, totalTokens, cost,
        upstreamStatus: upstreamResp.status,
      });
    } else {
      try {
        await recordUsage(sql, {
          userId, keyId, model, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0,
          upstreamStatus: upstreamResp.status,
        });
      } catch (err) {
        console.error('[proxy] recordUsage failed after upstream error:', err);
      }
    }

    return c.json(respBody, upstreamResp.status as any);
  });

  return proxy;
}
