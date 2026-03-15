import { describe, it, expect, beforeAll, afterAll, afterEach, mock, spyOn } from 'bun:test';
import { setupTestDb, cleanupTestDb, teardownTestDb, getApp, getSql, createTestUser } from '../setup';

// We need to set GITHUB_CLIENT_ID before importing config
process.env.GITHUB_CLIENT_ID = 'test-client-id';
process.env.GITHUB_CLIENT_SECRET = 'test-secret';

beforeAll(async () => { await setupTestDb(); });
afterEach(async () => { await cleanupTestDb(); });
afterAll(async () => { await teardownTestDb(); });

// Helper to mock global fetch for GitHub API calls
function mockGitHubFetch(responses: Record<string, any>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;

    for (const [pattern, response] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Pass through non-GitHub requests (like local app requests)
    return originalFetch(input, init);
  }) as typeof fetch;

  return () => { globalThis.fetch = originalFetch; };
}

describe('POST /oauth/device/code', () => {
  it('returns 400 without client_id', async () => {
    const app = getApp();
    const res = await app.request('/oauth/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for wrong client_id', async () => {
    const app = getApp();
    const res = await app.request('/oauth/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: 'wrong-id' }),
    });
    expect(res.status).toBe(400);
  });

  it('proxies to GitHub and stores session', async () => {
    const restore = mockGitHubFetch({
      'login/device/code': {
        device_code: 'gh-device-123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        interval: 5,
        expires_in: 900,
      },
    });

    try {
      const app = getApp();
      const res = await app.request('/oauth/device/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: 'test-client-id' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.device_code).toBe('gh-device-123');
      expect(body.data.user_code).toBe('ABCD-1234');
      expect(body.data.verification_uri).toBe('https://github.com/login/device');
    } finally {
      restore();
    }
  });
});

describe('POST /oauth/device/token', () => {
  it('returns pending status', async () => {
    const sql = getSql();
    // Insert a pending session
    await sql`
      INSERT INTO oauth_sessions (device_code, user_code, client_id, expires_at)
      VALUES ('pending-code', 'XXXX-YYYY', 'test-client-id', ${new Date(Date.now() + 900000)})
    `;

    const restore = mockGitHubFetch({
      'login/oauth/access_token': { error: 'authorization_pending' },
    });

    try {
      const app = getApp();
      const res = await app.request('/oauth/device/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: 'pending-code' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toBe('authorization_pending');
    } finally {
      restore();
    }
  });

  it('returns access_token on success', async () => {
    const sql = getSql();
    await sql`
      INSERT INTO oauth_sessions (device_code, user_code, client_id, expires_at)
      VALUES ('success-code', 'ZZZZ-WWWW', 'test-client-id', ${new Date(Date.now() + 900000)})
    `;

    const restore = mockGitHubFetch({
      'login/oauth/access_token': { access_token: 'ghu_test123', token_type: 'bearer' },
    });

    try {
      const app = getApp();
      const res = await app.request('/oauth/device/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: 'success-code' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.data.access_token).toBe('ghu_test123');
    } finally {
      restore();
    }
  });

  it('returns expired_token for expired session', async () => {
    const sql = getSql();
    await sql`
      INSERT INTO oauth_sessions (device_code, user_code, client_id, expires_at)
      VALUES ('expired-code', 'AAAA-BBBB', 'test-client-id', ${new Date(Date.now() - 1000)})
    `;

    const app = getApp();
    const res = await app.request('/oauth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: 'expired-code' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('expired_token');
  });
});
