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

    // model 是必填欄位
    const model = body.model as string | undefined;
    if (!model) {
      throw new AppError('INVALID_INPUT', 'model is required', 400);
    }

    // 預檢帳戶 credits（非精確扣減，僅確認帳戶有餘額）
    const balanceRows = await sql`
      SELECT total_credits, total_usage
      FROM credit_balances
      WHERE user_id = ${userId}::uuid
    `;

    if (balanceRows.length === 0 || Number(balanceRows[0].total_credits) - Number(balanceRows[0].total_usage) <= 0) {
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

      // 同步記錄 usage，確保 credits 扣減與 usage_logs 寫入在回傳前完成
      try {
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
      } catch (err) {
        // usage 記錄失敗不影響 response，但需要告警（未來可接 alerting）
        console.error('[proxy] recordUsage failed after successful upstream call:', err);
      }
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
