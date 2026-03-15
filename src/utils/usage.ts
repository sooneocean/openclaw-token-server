import type { Sql } from '../db/client';

export interface RecordUsageParams {
  userId: string;
  keyId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  upstreamStatus: number | null;
}

/**
 * 在單一 transaction 內完成三步 usage 記錄：
 * 1. 更新 provisioned_keys.usage（累加 cost）
 * 2. 更新 credit_balances.total_usage（累加 cost）
 * 3. 插入 usage_logs 記錄
 *
 * Transaction 失敗時全部 rollback，確保資料一致性。
 */
export async function recordUsage(sql: Sql, params: RecordUsageParams): Promise<void> {
  await sql.begin(async (tx) => {
    // 1. 累加 provisioned key 的使用量
    await tx`
      UPDATE provisioned_keys
      SET usage = usage + ${params.cost}
      WHERE id = ${params.keyId}::uuid
    `;

    // 2. 累加帳戶的總使用量
    await tx`
      UPDATE credit_balances
      SET total_usage = total_usage + ${params.cost}, updated_at = now()
      WHERE user_id = ${params.userId}::uuid
    `;

    // 3. 插入使用紀錄
    await tx`
      INSERT INTO usage_logs (
        user_id, key_id, model,
        prompt_tokens, completion_tokens, total_tokens,
        cost, upstream_status
      ) VALUES (
        ${params.userId}::uuid,
        ${params.keyId}::uuid,
        ${params.model},
        ${params.promptTokens},
        ${params.completionTokens},
        ${params.totalTokens},
        ${params.cost},
        ${params.upstreamStatus}
      )
    `;
  });
}
