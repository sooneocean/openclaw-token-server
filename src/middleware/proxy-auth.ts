import type { Context, Next } from 'hono';
import type { Sql } from '../db/client';
import { AppError } from '../errors';

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
      SELECT id, user_id, credit_limit, usage, disabled, is_revoked
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
      const usage = Number(key.usage);
      const creditLimit = Number(key.credit_limit);
      if (usage >= creditLimit) {
        throw new AppError('CREDIT_LIMIT_EXCEEDED', 'Key credit limit exceeded', 402);
      }
    }

    // 設定 context 供後續 handler 使用
    c.set('userId', key.user_id);
    c.set('keyId', key.id);

    await next();
  };
}
