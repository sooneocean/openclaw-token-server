import { Hono } from 'hono';
import type { Sql } from '../db/client';
import { config } from '../config';
import { AppError } from '../errors';
import { proxyAuthMiddleware } from '../middleware/proxy-auth';
import { calculateCost } from '../utils/pricing';
import { recordUsage } from '../utils/usage';

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

    // 拒絕 streaming 請求（尚未支援）
    if (body.stream === true) {
      throw new AppError('UNSUPPORTED', 'Streaming is not yet supported. Remove "stream": true from your request.', 400);
    }

    // model 是必填欄位
    const model = body.model as string | undefined;
    if (!model) {
      throw new AppError('INVALID_INPUT', 'model is required', 400);
    }

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
        // SELECT FOR UPDATE 防止並行 race condition
        const [locked] = await tx`
          SELECT total_credits, total_usage FROM credit_balances
          WHERE user_id = ${userId}::uuid FOR UPDATE
        `;
        const lockedRemaining = Number(locked.total_credits) - Number(locked.total_usage);
        // 再次檢查（可能其他請求已經 topup 了）
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

    // 轉發到上游 LLM API
    const upstreamUrl = `${config.upstreamApiBase}/v1/chat/completions`;

    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 替換為上游 API key，不洩漏給 caller
          'Authorization': `Bearer ${config.upstreamApiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // 網路層錯誤（連線失敗、DNS 解析失敗等）
      throw new AppError('UPSTREAM_UNREACHABLE', `Upstream LLM unreachable: ${(err as Error).message}`, 502);
    }

    // 讀取上游 response body
    let respBody: unknown;
    try {
      respBody = await upstreamResp.json();
    } catch {
      // 上游回傳非 JSON，降級為文字
      respBody = { error: { message: 'Upstream returned non-JSON response' } };
    }

    if (upstreamResp.ok) {
      // 上游成功（2xx）：提取 usage 並計費
      const usage = (respBody as any)?.usage ?? {};
      const promptTokens = Number(usage.prompt_tokens ?? 0);
      const completionTokens = Number(usage.completion_tokens ?? 0);
      const totalTokens = Number(usage.total_tokens ?? 0);
      const cost = calculateCost(model, promptTokens, completionTokens);

      // 同步記錄 usage — 失敗時回傳 500，防止免費使用
      await recordUsage(sql, {
        userId,
        keyId,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        cost,
        upstreamStatus: upstreamResp.status,
      });
    } else {
      // 上游錯誤（4xx/5xx）：記錄 cost=0 的 usage log，方便監控上游錯誤率
      try {
        await recordUsage(sql, {
          userId,
          keyId,
          model,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          cost: 0,
          upstreamStatus: upstreamResp.status,
        });
      } catch (err) {
        console.error('[proxy] recordUsage failed after upstream error:', err);
      }
    }

    // 原樣回傳上游 response body 與 status code
    return c.json(respBody, upstreamResp.status as any);
  });

  return proxy;
}
