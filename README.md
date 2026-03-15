# openclaw-token-server

> Backend API server for the OpenClaw Token proxy — handles auth, credit management, provisioned key lifecycle, and OpenAI-compatible LLM proxying with per-request cost tracking.

[![Bun](https://img.shields.io/badge/runtime-Bun-black)](https://bun.sh)
[![Hono](https://img.shields.io/badge/framework-Hono-orange)](https://hono.dev)
[![PostgreSQL](https://img.shields.io/badge/database-PostgreSQL%2016-blue)](https://www.postgresql.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## ✨ Features

- 🔐 **Auth** — email/password registration + login, management key rotation, GitHub OAuth Device Flow
- 💳 **Credits** — purchase (with idempotency), transaction history, auto top-up on low balance
- 🔑 **Provisioned keys** — create, list, update, rotate, revoke; per-key credit limits with daily/weekly/monthly reset
- 🔀 **OpenAI-compatible proxy** (`POST /v1/chat/completions`) — forwards to any upstream LLM API using a server-side key; charges credits per request based on token usage
- 📊 **Usage logging** — every proxy request records model, token counts, cost, and upstream HTTP status
- 🔄 **Auto top-up** — automatically refills credits when balance drops below a configured threshold
- 🛡️ **Security headers** — HSTS, X-Frame-Options, X-Content-Type-Options on all responses
- 🗄️ **Migration-based schema** — sequential SQL migrations applied automatically on startup

---

## 🚀 Quick Start

### Option A — Docker Compose (recommended)

```bash
git clone https://github.com/openclaw/openclaw-token-server
cd openclaw-token-server

# Set required secrets
export UPSTREAM_API_KEY=sk-...          # your OpenAI / upstream LLM API key
export GITHUB_CLIENT_ID=Ov23li...       # optional, required for GitHub OAuth
export GITHUB_CLIENT_SECRET=...         # optional, required for GitHub OAuth

docker compose up -d
```

The server starts on `http://localhost:3000`. PostgreSQL data is persisted in the `pgdata` Docker volume. Migrations run automatically on first boot.

```bash
# Check it's running
curl http://localhost:3000
# → {"status":"ok"}
```

### Option B — Manual (Bun + local PostgreSQL)

**Requirements:** [Bun](https://bun.sh) ≥ 1.0, PostgreSQL 16

```bash
git clone https://github.com/openclaw/openclaw-token-server
cd openclaw-token-server
bun install

# Create a local database
createdb openclaw_token_dev

# Start the server (runs migrations automatically)
DATABASE_URL=postgres://localhost:5432/openclaw_token_dev \
UPSTREAM_API_KEY=sk-... \
bun run src/index.ts
```

---

## 📡 API Endpoints

All management endpoints require the `Authorization: Bearer <management_key>` header.
Proxy endpoints require `Authorization: Bearer <provisioned_key>`.

### Auth — `/auth`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/register` | None | Register a new account; returns management key |
| `POST` | `/auth/login` | None | Login; rotates and returns a new management key |
| `GET` | `/auth/me` | Management key | Current account info (email, plan, balance, key count) |
| `POST` | `/auth/rotate` | Management key | Rotate management key |

### Provisioned Keys — `/keys`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/keys` | Create a provisioned key |
| `GET` | `/keys` | List keys (`?include_revoked=true`) |
| `GET` | `/keys/:hash` | Key details with usage breakdown |
| `PATCH` | `/keys/:hash` | Update `credit_limit`, `limit_reset`, `disabled` |
| `DELETE` | `/keys/:hash` | Revoke a key |
| `POST` | `/keys/:hash/rotate` | Rotate key value (hash preserved) |

### Credits — `/credits`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/credits` | Balance (total, used, remaining) |
| `POST` | `/credits/purchase` | Add credits; supports `Idempotency-Key` header |
| `GET` | `/credits/history` | Transaction list (`?limit`, `?offset`, `?type`) |
| `GET` | `/credits/auto-topup` | Get auto top-up config |
| `PUT` | `/credits/auto-topup` | Set auto top-up (`enabled`, `threshold`, `amount`) |

### GitHub OAuth — `/oauth`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/oauth/device/code` | None | Initiate GitHub Device Flow; proxies to GitHub |
| `POST` | `/oauth/device/token` | None | Poll for GitHub access token |
| `GET` | `/oauth/userinfo` | Management key | Exchange GitHub token for OpenClaw account |

### Proxy — `/v1`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/chat/completions` | Provisioned key | OpenAI-compatible chat completions proxy |

---

## 🔀 Proxy Usage

The proxy endpoint is OpenAI API-compatible. Point any OpenAI SDK to the server using a provisioned key.

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer ocpk_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

**With the OpenAI Python SDK:**

```python
from openai import OpenAI

client = OpenAI(
    api_key="ocpk_...",              # provisioned key
    base_url="http://localhost:3000/v1",
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}],
)
```

**How billing works:**

1. The server validates the provisioned key and checks the account's credit balance.
2. If auto top-up is enabled and balance is below threshold, credits are added automatically before the request proceeds.
3. The request is forwarded to the upstream LLM API using the server-side `UPSTREAM_API_KEY` (never exposed to callers).
4. On a successful upstream response, token usage is extracted and cost is deducted from the credit balance.
5. Every request (success or upstream error) is recorded in `usage_logs`.

---

## 🔧 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | `postgres://localhost:5432/openclaw_token_dev` | PostgreSQL connection string |
| `UPSTREAM_API_KEY` | Yes | — | API key forwarded to the upstream LLM provider |
| `UPSTREAM_API_BASE` | No | `https://api.openai.com` | Upstream LLM API base URL |
| `PORT` | No | `3000` | HTTP port to listen on |
| `GITHUB_CLIENT_ID` | No* | — | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | No* | — | GitHub OAuth App client secret |

\* Required only if GitHub OAuth login is used.

---

## 🗄️ Database Schema

Six tables managed by sequential SQL migrations in `src/db/migrations/`.

| Table | Description |
|-------|-------------|
| `users` | User accounts; supports both email/password and GitHub OAuth (`github_id`) |
| `management_keys` | Rotating bearer tokens for the management API; one active per user |
| `provisioned_keys` | Per-user API keys for the proxy endpoint; support credit limits and expiry |
| `credit_balances` | Per-user ledger with total credits, total usage, and auto top-up config |
| `credit_transactions` | Immutable transaction log (`purchase`, `usage`, `refund`, `auto_topup`) |
| `oauth_sessions` | GitHub Device Flow sessions; stores device code, user code, and access token |
| `usage_logs` | Per-request proxy log: model, token counts, cost, upstream HTTP status |

Schema highlights:

- All primary keys are UUIDs (`gen_random_uuid()`)
- Management and provisioned keys use partial unique indexes to allow multiple historical rows while enforcing uniqueness on active (`is_revoked = false`) keys
- `credit_transactions` supports idempotency via a unique `idempotency_key` column

---

## 🔧 Development

```bash
bun install

# Dev mode with hot reload
bun --watch src/index.ts

# Run tests (44 tests)
bun test

# Run a specific test file
bun test tests/auth.test.ts
```

Tests use Bun's built-in test runner. Each test file spins up an isolated in-memory Postgres schema (via `postgres.js` transactions) — no external test database required.

---

## 📄 License

[MIT](LICENSE)
