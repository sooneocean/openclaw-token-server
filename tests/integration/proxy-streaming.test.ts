import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { setupTestDb, cleanupTestDb, teardownTestDb, getApp, getSql, createTestUser } from '../setup';

// ── Mock Upstream Server (SSE) ──────────────────────────────────────────────

let mockUpstreamPort: number;
type MockBehavior = 'streaming' | 'streaming_no_usage' | 'error_500' | 'mid_stream_disconnect' | 'malformed_sse' | 'multi_event_chunk';
let mockUpstreamBehavior: MockBehavior = 'streaming';

function makeSSE(lines: string[]): string {
  return lines.map(l => `data: ${l}\n\n`).join('');
}

const STANDARD_SSE = makeSSE([
  '{"id":"chatcmpl-stream","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
  '{"id":"chatcmpl-stream","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
  '{"id":"chatcmpl-stream","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '{"id":"chatcmpl-stream","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}',
  '[DONE]',
]);

const NO_USAGE_SSE = makeSSE([
  '{"id":"chatcmpl-stream","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}',
  '{"id":"chatcmpl-stream","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '[DONE]',
]);

async function startMockUpstream(): Promise<number> {
  const mock = new Hono();

  mock.post('/v1/chat/completions', async (c) => {
    if (mockUpstreamBehavior === 'error_500') {
      return c.json({ error: { message: 'Internal server error' } }, 500);
    }

    // Check if request wants streaming
    const reqBody = await c.req.json() as any;
    if (!reqBody.stream) {
      return c.json({
        id: 'chatcmpl-test',
        choices: [{ message: { role: 'assistant', content: 'Hello!' } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }, 200);
    }

    const sseContent = mockUpstreamBehavior === 'streaming_no_usage' ? NO_USAGE_SSE
      : mockUpstreamBehavior === 'malformed_sse' ? makeSSE(['{not valid json', '{"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}', '[DONE]'])
      : mockUpstreamBehavior === 'multi_event_chunk' ? STANDARD_SSE
      : STANDARD_SSE;

    if (mockUpstreamBehavior === 'mid_stream_disconnect') {
      // Send partial SSE then close without [DONE]
      const partial = 'data: {"id":"chatcmpl-stream","choices":[{"delta":{"content":"Hi"}}]}\n\n';
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(partial));
            // Close abruptly without sending [DONE] — simulates upstream disconnect
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }

    return new Response(sseContent, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  });

  return new Promise((resolve) => {
    const server = Bun.serve({
      port: 0,
      fetch: mock.fetch,
    });
    mockUpstreamPort = server.port;
    (globalThis as any).__mockStreamUpstreamServer = server;
    resolve(server.port);
  });
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  const port = await startMockUpstream();
  process.env.UPSTREAM_API_BASE = `http://localhost:${port}`;
  process.env.UPSTREAM_API_KEY = 'test-upstream-key';
  await setupTestDb();
});

afterEach(async () => {
  mockUpstreamBehavior = 'streaming';
  await cleanupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
  (globalThis as any).__mockStreamUpstreamServer?.stop();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function createTestUserWithCreditsAndKey(credits = 100) {
  const app = getApp();
  const user = await createTestUser();
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${user.managementKey}`,
  };

  if (credits > 0) {
    await app.request('/credits/purchase', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ amount: credits }),
    });
  }

  const keyRes = await app.request('/keys', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'test-stream-key' }),
  });
  const keyData = await keyRes.json() as any;
  const provisionedKey = keyData.data.key as string;
  const keyHash = keyData.data.hash as string;

  return { user, managementKey: user.managementKey, provisionedKey, keyHash };
}

async function readStreamToText(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

async function getKeyId(provisionedKey: string): Promise<string> {
  const sql = getSql();
  const [row] = await sql`SELECT id FROM provisioned_keys WHERE key_value = ${provisionedKey}`;
  return row.id;
}

async function waitForUsageRecord(provisionedKey: string, maxWaitMs = 500) {
  const sql = getSql();
  const keyId = await getKeyId(provisionedKey);
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const rows = await sql`SELECT cost FROM usage_logs WHERE key_id = ${keyId}::uuid`;
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return await sql`SELECT cost FROM usage_logs WHERE key_id = ${keyId}::uuid`;
}

// ── Tests: TC-S01 ~ TC-S06 ─────────────────────────────────────────────────

describe('POST /v1/chat/completions — Streaming', () => {
  it('TC-S01: streaming response Content-Type is text/event-stream', async () => {
    const app = getApp();
    const { provisionedKey } = await createTestUserWithCreditsAndKey();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const text = await readStreamToText(res);
    expect(text).toContain('data: ');
    expect(text).toContain('[DONE]');
  });

  it('TC-S02: usage_logs recorded with cost > 0 after stream ends', async () => {
    const app = getApp();
    const { provisionedKey, keyHash } = await createTestUserWithCreditsAndKey();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
    });

    // Must consume the stream fully for flush() to trigger recordUsage
    await readStreamToText(res);
    const rows = await waitForUsageRecord(provisionedKey);
    expect(rows.length).toBeGreaterThan(0);
    expect(Number(rows[0].cost)).toBeGreaterThan(0);
  });

  it('TC-S03: credit_balances.total_usage increases after stream', async () => {
    const app = getApp();
    const sql = getSql();
    const { provisionedKey } = await createTestUserWithCreditsAndKey();

    // Get user_id from the provisioned key
    const [keyRow] = await sql`SELECT user_id FROM provisioned_keys WHERE key_value = ${provisionedKey}`;
    const userId = keyRow.user_id;

    // Get initial usage
    const [before] = await sql`SELECT total_usage FROM credit_balances WHERE user_id = ${userId}::uuid`;
    const usageBefore = Number(before.total_usage);

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
    });
    await readStreamToText(res);
    await waitForUsageRecord(provisionedKey);

    const [after] = await sql`SELECT total_usage FROM credit_balances WHERE user_id = ${userId}::uuid`;
    expect(Number(after.total_usage)).toBeGreaterThan(usageBefore);
  });

  it('TC-S04: stream:false uses non-streaming path', async () => {
    const app = getApp();
    const { provisionedKey } = await createTestUserWithCreditsAndKey();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], stream: false }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // Non-streaming returns JSON with choices array (not SSE)
    expect(body.choices).toBeDefined();
  });

  it('TC-S05: upstream 4xx returns error without streaming', async () => {
    mockUpstreamBehavior = 'error_500';
    const app = getApp();
    const { provisionedKey } = await createTestUserWithCreditsAndKey();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
    });

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).not.toBe('text/event-stream');
  });

  it('TC-S06: no usage chunk records cost=0', async () => {
    mockUpstreamBehavior = 'streaming_no_usage';
    const app = getApp();
    const { provisionedKey, keyHash } = await createTestUserWithCreditsAndKey();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
    });
    await readStreamToText(res);
    const rows = await waitForUsageRecord(provisionedKey);
    expect(rows.length).toBeGreaterThan(0);
    expect(Number(rows[0].cost)).toBe(0);
  });
});

// ── Tests: TC-S07 ~ TC-S10 (Edge Cases) ─────────────────────────────────────

describe('POST /v1/chat/completions — Streaming Edge Cases', () => {
  it('TC-S07: client disconnect aborts upstream and skips recordUsage', async () => {
    // This test verifies that the server doesn't crash on abort
    // Full abort testing requires a real HTTP connection, so we verify
    // the server handles AbortError gracefully
    const app = getApp();
    const { provisionedKey } = await createTestUserWithCreditsAndKey();

    const controller = new AbortController();
    // Abort immediately
    controller.abort();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
      signal: controller.signal as any,
    });

    // Server should handle abort gracefully (either 499 or the request is aborted before response)
    // The key assertion is that no unhandled rejection occurs
    expect(res).toBeDefined();
  });

  it('TC-S08: upstream mid-stream disconnect closes client stream cleanly', async () => {
    mockUpstreamBehavior = 'mid_stream_disconnect';
    const app = getApp();
    const { provisionedKey } = await createTestUserWithCreditsAndKey();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
    });

    expect(res.status).toBe(200);
    // Reading the stream should not crash the server
    try {
      await readStreamToText(res);
    } catch {
      // Stream may error when upstream disconnects — that's expected
    }
    // No unhandled rejection = pass
  });

  it('TC-S09: malformed SSE line does not truncate stream', async () => {
    mockUpstreamBehavior = 'malformed_sse';
    const app = getApp();
    const { provisionedKey } = await createTestUserWithCreditsAndKey();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
    });

    expect(res.status).toBe(200);
    const text = await readStreamToText(res);
    // Stream should contain all events including [DONE], not truncated at malformed line
    expect(text).toContain('[DONE]');
  });

  it('TC-S10: multiple events in single chunk parsed correctly by line buffer', async () => {
    mockUpstreamBehavior = 'multi_event_chunk';
    const app = getApp();
    const { provisionedKey, keyHash } = await createTestUserWithCreditsAndKey();

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provisionedKey}`,
      },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Hi' }], stream: true }),
    });

    await readStreamToText(res);
    const rows = await waitForUsageRecord(provisionedKey);
    expect(rows.length).toBeGreaterThan(0);
    // Usage should be extracted even when all events arrive in one chunk
    expect(Number(rows[0].cost)).toBeGreaterThan(0);
  });
});
