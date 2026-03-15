CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT,
    plan            TEXT NOT NULL DEFAULT 'free',
    github_id       BIGINT UNIQUE,
    avatar_url      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Management Keys
CREATE TABLE management_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    key_value       TEXT NOT NULL UNIQUE,
    is_revoked      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX idx_mgmt_keys_key_value ON management_keys(key_value) WHERE is_revoked = false;
CREATE INDEX idx_mgmt_keys_user_id ON management_keys(user_id);

-- Provisioned Keys
CREATE TABLE provisioned_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    hash            TEXT NOT NULL UNIQUE,
    key_value       TEXT NOT NULL,
    name            TEXT NOT NULL,
    credit_limit    NUMERIC,
    limit_reset     TEXT CHECK (limit_reset IN ('daily', 'weekly', 'monthly')),
    usage           NUMERIC NOT NULL DEFAULT 0,
    disabled        BOOLEAN NOT NULL DEFAULT false,
    is_revoked      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX idx_prov_keys_user_id ON provisioned_keys(user_id);
CREATE UNIQUE INDEX idx_prov_keys_user_name_active
    ON provisioned_keys(user_id, name) WHERE is_revoked = false;

-- Credit Balances
CREATE TABLE credit_balances (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL UNIQUE REFERENCES users(id),
    total_credits           NUMERIC NOT NULL DEFAULT 0,
    total_usage             NUMERIC NOT NULL DEFAULT 0,
    auto_topup_enabled      BOOLEAN NOT NULL DEFAULT false,
    auto_topup_threshold    NUMERIC NOT NULL DEFAULT 5,
    auto_topup_amount       NUMERIC NOT NULL DEFAULT 25,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credit Transactions
CREATE TABLE credit_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    type            TEXT NOT NULL CHECK (type IN ('purchase', 'usage', 'refund')),
    amount          NUMERIC NOT NULL,
    balance_after   NUMERIC NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_credit_txn_user_id ON credit_transactions(user_id);
CREATE INDEX idx_credit_txn_user_type ON credit_transactions(user_id, type);

-- OAuth Sessions
CREATE TABLE oauth_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_code         TEXT NOT NULL UNIQUE,
    user_code           TEXT NOT NULL,
    client_id           TEXT NOT NULL,
    github_access_token TEXT,
    user_id             UUID REFERENCES users(id),
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'authorized', 'expired')),
    expires_at          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
