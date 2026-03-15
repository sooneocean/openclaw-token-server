-- usage_logs 表：記錄每次 proxy 請求的 token 使用量與費用
CREATE TABLE usage_logs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id),
    key_id            UUID NOT NULL REFERENCES provisioned_keys(id),
    model             TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    cost              NUMERIC NOT NULL DEFAULT 0,
    upstream_status   INTEGER,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 依 user_id 查詢使用記錄
CREATE INDEX idx_usage_logs_user_id ON usage_logs(user_id);
-- 依 key_id 查詢使用記錄
CREATE INDEX idx_usage_logs_key_id ON usage_logs(key_id);
-- 依時間排序與範圍查詢
CREATE INDEX idx_usage_logs_created_at ON usage_logs(created_at);
