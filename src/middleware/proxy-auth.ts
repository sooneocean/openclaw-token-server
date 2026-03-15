import type { Context, Next } from 'hono';
import type { Sql } from '../db/client';
import { AppError } from '../errors';

function getPeriodStart(limitReset: string): string {
  const now = new Date();
  switch (limitReset) {
    case 'daily':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    case 'weekly': {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday start
      return new Date(now.getFullYear(), now.getMonth(), diff).toISOString();
    }
    case 'monthly':
      return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    default:
      return new Date(0).toISOString(); // fallback: epoch
  }
}

/**
 * Provisioned Key 驗證 middleware
 * 解析 Authorization: Bearer sk-prov-xxx，查 provisioned_keys 表驗證有效性
 * 通過後設定 context: userId、keyId
 */
export function proxyAuthMiddleware(sql: Sql) {
  return async (c: Context, next: Next) => {
    const header = c.req.header('Authorization');
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('UNAUTHORIZED', 'Missing or invalid authorization header', 401);
    }

    const token = header.slice(7);

    // 查詢 provisioned key 狀態
    const rows = await sql`
      SELECT id, user_id, credit_limit, limit_reset, usage, disabled, is_revoked
      FROM provisioned_keys
      WHERE key_value = ${token}
    `;

    if (rows.length === 0) {
      throw new AppError('UNAUTHORIZED', 'Invalid or revoked key', 401);
    }

    const key = rows[0];

    // 依序檢查 key 狀態
    if (key.is_revoked) {
      throw new AppError('KEY_REVOKED', 'Key has been revoked', 401);
    }

    if (key.disabled) {
      throw new AppError('KEY_DISABLED', 'Key is disabled', 401);
    }

    // 檢查 key 層級的 credit limit（若有設定）
    if (key.credit_limit !== null && key.credit_limit !== undefined) {
      const creditLimit = Number(key.credit_limit);

      if (key.limit_reset) {
        // Period-based limit: 查 usage_logs 當期用量
        const periodStart = getPeriodStart(key.limit_reset);
        const periodUsageRows = await sql`
          SELECT COALESCE(SUM(cost), 0) AS period_cost
          FROM usage_logs
          WHERE key_id = ${key.id}::uuid
            AND created_at >= ${periodStart}
        `;
        const periodUsage = Number(periodUsageRows[0]?.period_cost ?? 0);
        if (periodUsage >= creditLimit) {
          throw new AppError('CREDIT_LIMIT_EXCEEDED', `Key credit limit exceeded for current ${key.limit_reset} period`, 429);
        }
      } else {
        // No reset period: 累計用量檢查
        const usage = Number(key.usage);
        if (usage >= creditLimit) {
          throw new AppError('CREDIT_LIMIT_EXCEEDED', 'Key credit limit exceeded', 429);
        }
      }
    }

    // 設定 context 供後續 handler 使用
    c.set('userId', key.user_id);
    c.set('keyId', key.id);

    await next();
  };
}
