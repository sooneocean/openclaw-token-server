import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { setupTestDb, cleanupTestDb, teardownTestDb, getApp, getSql, createTestUser } from '../setup';

// ── Mock Upstream Server ──────────────────────────────────────────────────────
// 在測試過程中啟動一個本地 Hono server 模擬上游 LLM API

let mockUpstreamPort: number;
let mockUpstreamServer: ReturnType<typeof serve> | null = null;

// 上游回傳的控制旗標，方便不同測試案例切換行為
let mockUpstreamBehavior: 'success' | 'error_500' | 'no_usage' | 'unavailable' = 'success';

async function startMockUpstream(): Promise<number> {
  const mock = new Hono();

  mock.post('/v1/chat/completions', (c) => {
    if (mockUpstreamBehavior === 'error_500') {
      return c.json({ error: { message: 'Internal server error' } }, 500);
    }
    if (mockUpstreamBehavior === 'no_usage') {
      // 回傳沒有 usage 欄位的 response
      return c.json({
        id: 'chatcmpl-test',
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
      }, 200);
    }
    // success：回傳標準 OpenAI 格式，包含 usage
    return c.json({
      id: 'chatcmpl-test',
      choices: [{ message: { role: 'assistant', content: 'Hello!' } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    }, 200);
  });

  // 找一個可用的隨機 port
  return new Promise((resolve) => {
    const server = Bun.serve({
      port: 0, // 讓 OS 分配可用 port
      fetch: mock.fetch,
    });
    mockUpstreamPort = server.port;
    // 用 Bun.serve 回傳的物件關閉 server
    (globalThis as any).__mockUpstreamServer = server;
    resolve(server.port);
  });
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // 啟動 mock upstream
  const port = await startMockUpstream();
  // 設定環境變數讓 proxy route 指向 mock server
  process.env.UPSTREAM_API_BASE = `http://localhost:${port}`;
  process.env.UPSTREAM_API_KEY = 'test-upstream-key';

  await setupTestDb();
});

afterEach(async () => {
  mockUpstreamBehavior = 'success'; // 每次測試後重設行為
  await cleanupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
  // 關閉 mock upstream server
  (globalThis as any).__mockUpstreamServer?.stop();
});

// ── 輔助函式 ─────────────────────────────────────────────────────────────────

async function createTestUserWithCreditsAndKey(credits = 100, creditLimit?: number) {
  const app = getApp();
  const sql = getSql();
  const user = await createTestUser();
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${user.managementKey}`,
  };

  // 購買 credits
  if (credits > 0) {
    await app.request('/credits/purchase', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ amount: credits }),
    });
  }

  // 建立 provisioned key
  const keyBody: Record<string, unknown> = { name: 'test-proxy-key' };
  if (creditLimit !== undefined) keyBody.credit_limit = creditLimit;

  const keyRes = await app.request('/keys', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(keyBody),
  });
  const keyData = await keyRes.json() as any;
  const provisionedKey = keyData.data.key as string;
  const keyHash = keyData.data.hash as string;

  return { user, managementKey: user.managementKey, provisionedKey, keyHash };
}

/** 等待 recordUsage 非同步完成（最多等 200ms） */
async function waitForUsageRecord(sql: ReturnType<typeof getSql>, keyId: string, maxWaitMs = 200) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const rows = await sql`SELECT COUNT(*) as count FROM usage_logs WHERE key_id = ${keyId}::uuid`;
    if (Number(rows[0].count) > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /v1/chat/completions — 成功轉發', () => {
  it('TC-01: 有效 key + 足夠 credits → 200 + 原始 response body', async () => {
    const app = getApp();
    const { provisionedKey } = await createTestUserWithCreditsAndKey();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.choices).toBeDefined();
    expect(body.usage.prompt_tokens).toBe(100);
    expect(body.usage.completion_tokens).toBe(50);
  });
});

describe('POST /v1/chat/completions — Auth 驗證', () => {
  it('TC-02: 無 Authorization header → 401', async () => {
    const app = getApp();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });

    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('TC-03: 不存在的 key → 401 UNAUTHORIZED', async () => {
    const app = getApp();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-prov-nonexistent',
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });

    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('TC-04: Revoked key → 401 KEY_REVOKED', async () => {
    const app = getApp();
    const { provisionedKey, keyHash, managementKey } = await createTestUserWithCreditsAndKey();

    // 撤銷該 key
    await app.request(`/keys/${keyHash}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${managementKey}` },
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });

    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('KEY_REVOKED');
  });

  it('TC-05: Disabled key → 401 KEY_DISABLED', async () => {
    const app = getApp();
    const sql = getSql();
    const { provisionedKey, keyHash, managementKey } = await createTestUserWithCreditsAndKey();

    // 直接更新 DB 把 key disable（目前 API 未提供 disable endpoint，直接操作 DB）
    await sql`UPDATE provisioned_keys SET disabled = true WHERE hash = ${keyHash}`;

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });

    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('KEY_DISABLED');
  });
});

describe('POST /v1/chat/completions — Credits 檢查', () => {
  it('TC-06: Key credit_limit 超限 → 402 CREDIT_LIMIT_EXCEEDED', async () => {
    const app = getApp();
    const sql = getSql();
    // credit_limit = 0.001，直接超限（usage 初始為 0，但 0 >= 0.001 為 false，所以需要先累積 usage）
    const { provisionedKey, keyHash } = await createTestUserWithCreditsAndKey(100, 0.001);

    // 直接設定 usage >= credit_limit
    await sql`UPDATE provisioned_keys SET usage = 0.002 WHERE hash = ${keyHash}`;

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe('CREDIT_LIMIT_EXCEEDED');
  });

  it('TC-07: 帳戶餘額不足 → 402 INSUFFICIENT_CREDITS', async () => {
    const app = getApp();
    // 建立用戶但不購買 credits（credits = 0）
    const { provisionedKey } = await createTestUserWithCreditsAndKey(0);

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
    });

    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error.code).toBe('INSUFFICIENT_CREDITS');
  });
});

describe('POST /v1/chat/completions — Input 驗證', () => {
  it('TC-08: 缺少 model 欄位 → 400 INVALID_INPUT', async () => {
    const app = getApp();
    const { provisionedKey } = await createTestUserWithCreditsAndKey();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('INVALID_INPUT');
  });
});

describe('POST /v1/chat/completions — 上游錯誤處理', () => {
  it('TC-09: 上游回傳 500 → 轉發 500 + usage_logs 記錄（cost=0）', async () => {
    const app = getApp();
    const sql = getSql();
    const { provisionedKey, keyHash } = await createTestUserWithCreditsAndKey();
    mockUpstreamBehavior = 'error_500';

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.error).toBeDefined();

    // 取得 keyId
    const keyRows = await sql`SELECT id FROM provisioned_keys WHERE hash = ${keyHash}`;
    const keyId = keyRows[0].id;

    // 等待非同步 recordUsage 完成
    await waitForUsageRecord(sql, keyId);

    // 確認 usage_logs 有記錄，cost = 0
    const logs = await sql`SELECT * FROM usage_logs WHERE key_id = ${keyId}::uuid`;
    expect(logs.length).toBe(1);
    expect(Number(logs[0].cost)).toBe(0);
    expect(logs[0].upstream_status).toBe(500);
  });

  it('TC-10: 上游不可達（無效 host）→ 502 UPSTREAM_UNREACHABLE', async () => {
    const app = getApp();
    const { provisionedKey } = await createTestUserWithCreditsAndKey();

    // 暫時覆蓋 UPSTREAM_API_BASE 指向不存在的 host
    const originalBase = process.env.UPSTREAM_API_BASE;
    process.env.UPSTREAM_API_BASE = 'http://localhost:19999'; // 不存在的 port

    try {
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provisionedKey}`,
        },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
      });

      expect(res.status).toBe(502);
      const body = await res.json() as any;
      expect(body.error.code).toBe('UPSTREAM_UNREACHABLE');
    } finally {
      process.env.UPSTREAM_API_BASE = originalBase;
    }
  });
});

describe('POST /v1/chat/completions — Usage 記錄驗證', () => {
  it('TC-11: Response 缺少 usage 欄位 → 記錄 tokens=0, cost=0', async () => {
    const app = getApp();
    const sql = getSql();
    const { provisionedKey, keyHash } = await createTestUserWithCreditsAndKey();
    mockUpstreamBehavior = 'no_usage';

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.status).toBe(200);

    const keyRows = await sql`SELECT id FROM provisioned_keys WHERE hash = ${keyHash}`;
    const keyId = keyRows[0].id;
    await waitForUsageRecord(sql, keyId);

    const logs = await sql`SELECT * FROM usage_logs WHERE key_id = ${keyId}::uuid`;
    expect(logs.length).toBe(1);
    expect(Number(logs[0].prompt_tokens)).toBe(0);
    expect(Number(logs[0].completion_tokens)).toBe(0);
    expect(Number(logs[0].cost)).toBe(0);
    expect(logs[0].upstream_status).toBe(200);
  });

  it('TC-12: 未知 model → 使用 default pricing 計算 cost', async () => {
    const app = getApp();
    const sql = getSql();
    const { provisionedKey, keyHash } = await createTestUserWithCreditsAndKey();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'unknown-model-xyz', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(res.status).toBe(200);

    const keyRows = await sql`SELECT id FROM provisioned_keys WHERE hash = ${keyHash}`;
    const keyId = keyRows[0].id;
    await waitForUsageRecord(sql, keyId);

    const logs = await sql`SELECT * FROM usage_logs WHERE key_id = ${keyId}::uuid`;
    expect(logs.length).toBe(1);
    // default pricing: input=5.00, output=15.00 per 1M tokens
    // mock 回傳 prompt=100, completion=50
    // cost = (100 * 5.00 + 50 * 15.00) / 1_000_000 = (500 + 750) / 1_000_000 = 0.00125
    const expectedCost = (100 * 5.00 + 50 * 15.00) / 1_000_000;
    expect(Number(logs[0].cost)).toBeCloseTo(expectedCost, 6);
  });

  it('TC-13: provisioned_keys.usage 正確累加', async () => {
    const app = getApp();
    const sql = getSql();
    const { provisionedKey, keyHash } = await createTestUserWithCreditsAndKey();

    // 查初始 usage
    const beforeRows = await sql`SELECT usage FROM provisioned_keys WHERE hash = ${keyHash}`;
    const usageBefore = Number(beforeRows[0].usage);

    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const keyRows = await sql`SELECT id FROM provisioned_keys WHERE hash = ${keyHash}`;
    const keyId = keyRows[0].id;
    await waitForUsageRecord(sql, keyId);

    // gpt-4o: input=2.50, output=10.00 per 1M
    // mock: prompt=100, completion=50
    // cost = (100 * 2.50 + 50 * 10.00) / 1_000_000 = (250 + 500) / 1_000_000 = 0.00075
    const expectedCost = (100 * 2.50 + 50 * 10.00) / 1_000_000;

    const afterRows = await sql`SELECT usage FROM provisioned_keys WHERE hash = ${keyHash}`;
    const usageAfter = Number(afterRows[0].usage);

    expect(usageAfter - usageBefore).toBeCloseTo(expectedCost, 6);
  });

  it('TC-14: credit_balances.total_usage 正確累加', async () => {
    const app = getApp();
    const sql = getSql();
    // 使用固定 email 以便之後查詢帳戶餘額
    const user = await createTestUser('proxy_balance_tc14@example.com');
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.managementKey}`,
    };

    // 購買 credits
    await app.request('/credits/purchase', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ amount: 50 }),
    });

    // 建立 provisioned key
    const keyRes = await app.request('/keys', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'balance-test-key' }),
    });
    const keyData = await keyRes.json() as any;
    const pKey = keyData.data.key as string;
    const kHash = keyData.data.hash as string;

    // 查初始 total_usage
    const userRowsBefore = await sql`
      SELECT cb.total_usage FROM credit_balances cb
      JOIN users u ON u.id = cb.user_id
      WHERE u.email = 'proxy_balance_tc14@example.com'
    `;
    const usageBefore = Number(userRowsBefore[0].total_usage);

    // 發送 proxy 請求
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const keyRows = await sql`SELECT id FROM provisioned_keys WHERE hash = ${kHash}`;
    const keyId = keyRows[0].id;
    await waitForUsageRecord(sql, keyId);

    // gpt-4o, prompt=100, completion=50 → cost = 0.00075
    const expectedCost = (100 * 2.50 + 50 * 10.00) / 1_000_000;

    const userRowsAfter = await sql`
      SELECT cb.total_usage FROM credit_balances cb
      JOIN users u ON u.id = cb.user_id
      WHERE u.email = 'proxy_balance_tc14@example.com'
    `;
    const usageAfter = Number(userRowsAfter[0].total_usage);

    expect(usageAfter - usageBefore).toBeCloseTo(expectedCost, 6);
  });
});

describe('現有路由不受影響', () => {
  it('TC-15: GET / 仍正常回應', async () => {
    const app = getApp();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('ok');
  });

  it('TC-16: 現有 management key auth 路由不受 proxy auth 影響', async () => {
    const app = getApp();
    const user = await createTestUser('existing_route@example.com');
    const res = await app.request('/credits', {
      headers: { Authorization: `Bearer ${user.managementKey}` },
    });
    expect(res.status).toBe(200);
  });
});
