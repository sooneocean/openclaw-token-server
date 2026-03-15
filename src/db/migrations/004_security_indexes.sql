-- P0-1: provisioned_keys.key_value 缺少索引
CREATE INDEX idx_prov_keys_key_value ON provisioned_keys(key_value) WHERE is_revoked = false;

-- P1-5: usage_logs 複合索引（rate limiting 效能）
CREATE INDEX idx_usage_logs_key_created ON usage_logs(key_id, created_at);
