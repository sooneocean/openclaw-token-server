import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { setupTestDb, cleanupTestDb, teardownTestDb, getApp, createTestUser } from '../setup';

beforeAll(async () => { await setupTestDb(); });
afterEach(async () => { await cleanupTestDb(); });
afterAll(async () => { await teardownTestDb(); });

describe('GET /credits', () => {
  it('returns zero balance for new user', async () => {
    const app = getApp();
    const user = await createTestUser();
    const res = await app.request('/credits', {
      headers: { Authorization: `Bearer ${user.managementKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.total_credits).toBe(0);
    expect(body.data.total_usage).toBe(0);
    expect(body.data.remaining).toBe(0);
  });
});

describe('POST /credits/purchase', () => {
  it('adds credits and returns correct response', async () => {
    const app = getApp();
    const user = await createTestUser();
    const res = await app.request('/credits/purchase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` },
      body: JSON.stringify({ amount: 10 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.amount).toBe(10);
    expect(body.data.platform_fee).toBe(0.80);  // max(10*0.055, 0.80) = max(0.55, 0.80) = 0.80
    expect(body.data.new_balance).toBe(10);
    expect(body.data.transaction_id).toBeTruthy();
  });

  it('rejects amount < 5 with 400', async () => {
    const app = getApp();
    const user = await createTestUser();
    const res = await app.request('/credits/purchase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` },
      body: JSON.stringify({ amount: 3 }),
    });
    expect(res.status).toBe(400);
  });

  it('calculates platform_fee correctly for larger amounts', async () => {
    const app = getApp();
    const user = await createTestUser();
    const res = await app.request('/credits/purchase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` },
      body: JSON.stringify({ amount: 100 }),
    });
    const body = await res.json() as any;
    expect(body.data.platform_fee).toBe(5.5);  // 100 * 0.055 = 5.50
  });

  it('idempotency returns same result', async () => {
    const app = getApp();
    const user = await createTestUser();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${user.managementKey}`,
      'Idempotency-Key': 'test-idem-123',
    };
    const body = JSON.stringify({ amount: 20 });

    const res1 = await app.request('/credits/purchase', { method: 'POST', headers, body });
    const res2 = await app.request('/credits/purchase', { method: 'POST', headers, body });

    const b1 = await res1.json() as any;
    const b2 = await res2.json() as any;
    expect(b1.data.new_balance).toBe(b2.data.new_balance);

    // Check balance only increased once
    const balRes = await app.request('/credits', {
      headers: { Authorization: `Bearer ${user.managementKey}` },
    });
    const bal = await balRes.json() as any;
    expect(bal.data.total_credits).toBe(20);
  });
});

describe('GET /credits/history', () => {
  it('returns transactions', async () => {
    const app = getApp();
    const user = await createTestUser();
    const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` };

    await app.request('/credits/purchase', { method: 'POST', headers: authHeaders, body: JSON.stringify({ amount: 10 }) });
    await app.request('/credits/purchase', { method: 'POST', headers: authHeaders, body: JSON.stringify({ amount: 20 }) });

    const res = await app.request('/credits/history', {
      headers: { Authorization: `Bearer ${user.managementKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.items.length).toBe(2);
    expect(body.data.total).toBe(2);
  });

  it('filters by type', async () => {
    const app = getApp();
    const user = await createTestUser();
    const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` };

    await app.request('/credits/purchase', { method: 'POST', headers: authHeaders, body: JSON.stringify({ amount: 10 }) });

    const res = await app.request('/credits/history?type=usage', {
      headers: { Authorization: `Bearer ${user.managementKey}` },
    });
    const body = await res.json() as any;
    expect(body.data.items.length).toBe(0);
  });
});

describe('GET /credits/auto-topup', () => {
  it('returns default config', async () => {
    const app = getApp();
    const user = await createTestUser();
    const res = await app.request('/credits/auto-topup', {
      headers: { Authorization: `Bearer ${user.managementKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.enabled).toBe(false);
    expect(body.data.threshold).toBe(5);
    expect(body.data.amount).toBe(25);
  });
});

describe('PUT /credits/auto-topup', () => {
  it('updates config', async () => {
    const app = getApp();
    const user = await createTestUser();
    const res = await app.request('/credits/auto-topup', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` },
      body: JSON.stringify({ enabled: true, threshold: 10, amount: 50 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.enabled).toBe(true);
    expect(body.data.threshold).toBe(10);
    expect(body.data.amount).toBe(50);
    expect(body.data.updated_at).toBeTruthy();
  });

  it('rejects invalid threshold', async () => {
    const app = getApp();
    const user = await createTestUser();
    const res = await app.request('/credits/auto-topup', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` },
      body: JSON.stringify({ threshold: 0 }),
    });
    expect(res.status).toBe(400);
  });
});
