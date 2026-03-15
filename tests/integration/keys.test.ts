import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { setupTestDb, cleanupTestDb, teardownTestDb, getApp, createTestUser } from '../setup';

beforeAll(async () => { await setupTestDb(); });
afterEach(async () => { await cleanupTestDb(); });
afterAll(async () => { await teardownTestDb(); });

describe('POST /keys', () => {
  it('creates key with correct format', async () => {
    const app = getApp();
    const user = await createTestUser();

    const res = await app.request('/keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${user.managementKey}`,
      },
      body: JSON.stringify({ name: 'test-key' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.key).toMatch(/^sk-prov-/);
    expect(body.data.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(body.data.name).toBe('test-key');
  });

  it('rejects duplicate name with 409', async () => {
    const app = getApp();
    const user = await createTestUser();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` };

    await app.request('/keys', { method: 'POST', headers, body: JSON.stringify({ name: 'dup' }) });
    const res = await app.request('/keys', { method: 'POST', headers, body: JSON.stringify({ name: 'dup' }) });
    expect(res.status).toBe(409);
  });

  it('rejects missing name with 400', async () => {
    const app = getApp();
    const user = await createTestUser();
    const res = await app.request('/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /keys', () => {
  it('returns list without key values', async () => {
    const app = getApp();
    const user = await createTestUser();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` };
    await app.request('/keys', { method: 'POST', headers, body: JSON.stringify({ name: 'k1' }) });

    const res = await app.request('/keys', { headers: { Authorization: `Bearer ${user.managementKey}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.items.length).toBe(1);
    expect(body.data.items[0].key).toBeUndefined();
    expect(body.data.total).toBe(1);
  });
});

describe('GET /keys/:hash', () => {
  it('returns detail with usage stats', async () => {
    const app = getApp();
    const user = await createTestUser();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` };
    const createRes = await app.request('/keys', { method: 'POST', headers, body: JSON.stringify({ name: 'detail' }) });
    const { data: { hash } } = await createRes.json() as any;

    const res = await app.request(`/keys/${hash}`, { headers: { Authorization: `Bearer ${user.managementKey}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.hash).toBe(hash);
    expect(body.data).toHaveProperty('usage_daily');
    expect(body.data).toHaveProperty('model_usage');
  });

  it('returns 404 for revoked key', async () => {
    const app = getApp();
    const user = await createTestUser();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` };
    const createRes = await app.request('/keys', { method: 'POST', headers, body: JSON.stringify({ name: 'rev' }) });
    const { data: { hash } } = await createRes.json() as any;

    await app.request(`/keys/${hash}`, { method: 'DELETE', headers: { Authorization: `Bearer ${user.managementKey}` } });

    const res = await app.request(`/keys/${hash}`, { headers: { Authorization: `Bearer ${user.managementKey}` } });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /keys/:hash', () => {
  it('revokes key', async () => {
    const app = getApp();
    const user = await createTestUser();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` };
    const createRes = await app.request('/keys', { method: 'POST', headers, body: JSON.stringify({ name: 'del' }) });
    const { data: { hash } } = await createRes.json() as any;

    const res = await app.request(`/keys/${hash}`, { method: 'DELETE', headers: { Authorization: `Bearer ${user.managementKey}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.revoked).toBe(true);
  });

  it('returns 410 if already revoked', async () => {
    const app = getApp();
    const user = await createTestUser();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` };
    const createRes = await app.request('/keys', { method: 'POST', headers, body: JSON.stringify({ name: 'del2' }) });
    const { data: { hash } } = await createRes.json() as any;

    await app.request(`/keys/${hash}`, { method: 'DELETE', headers: { Authorization: `Bearer ${user.managementKey}` } });
    const res = await app.request(`/keys/${hash}`, { method: 'DELETE', headers: { Authorization: `Bearer ${user.managementKey}` } });
    expect(res.status).toBe(410);
  });
});

describe('POST /keys/:hash/rotate', () => {
  it('generates new key value and keeps hash', async () => {
    const app = getApp();
    const user = await createTestUser();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` };
    const createRes = await app.request('/keys', { method: 'POST', headers, body: JSON.stringify({ name: 'rot' }) });
    const createBody = await createRes.json() as any;
    const originalKey = createBody.data.key;
    const hash = createBody.data.hash;

    const res = await app.request(`/keys/${hash}/rotate`, { method: 'POST', headers: { Authorization: `Bearer ${user.managementKey}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.key).toMatch(/^sk-prov-/);
    expect(body.data.key).not.toBe(originalKey);
    expect(body.data.hash).toBe(hash);
    expect(body.data.rotated_at).toBeTruthy();
  });

  it('returns 410 for revoked key', async () => {
    const app = getApp();
    const user = await createTestUser();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${user.managementKey}` };
    const createRes = await app.request('/keys', { method: 'POST', headers, body: JSON.stringify({ name: 'rot2' }) });
    const { data: { hash } } = await createRes.json() as any;

    await app.request(`/keys/${hash}`, { method: 'DELETE', headers: { Authorization: `Bearer ${user.managementKey}` } });
    const res = await app.request(`/keys/${hash}/rotate`, { method: 'POST', headers: { Authorization: `Bearer ${user.managementKey}` } });
    expect(res.status).toBe(410);
  });
});
