import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { setupTestDb, cleanupTestDb, teardownTestDb, getApp, createTestUser } from '../setup';

beforeAll(async () => { await setupTestDb(); });
afterEach(async () => { await cleanupTestDb(); });
afterAll(async () => { await teardownTestDb(); });

describe('POST /auth/register', () => {
  it('creates user and returns management key', async () => {
    const app = getApp();
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@test.com', password: 'Pass123!' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.data.management_key).toMatch(/^sk-mgmt-/);
    expect(body.data.email).toBe('new@test.com');
    expect(body.data.created_at).toBeTruthy();
  });

  it('rejects duplicate email with 409', async () => {
    const app = getApp();
    await createTestUser('dup@test.com');
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dup@test.com', password: 'Pass123!' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error.code).toBe('EMAIL_EXISTS');
  });

  it('rejects missing email with 400', async () => {
    const app = getApp();
    const res = await app.request('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'Pass123!' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/login', () => {
  it('returns new key and revokes old', async () => {
    const app = getApp();
    const user = await createTestUser('login@test.com');

    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'login@test.com', password: 'TestPass123!' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.management_key).toMatch(/^sk-mgmt-/);
    expect(body.data.management_key).not.toBe(user.managementKey);

    // Old key should be invalid
    const meRes = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${user.managementKey}` },
    });
    expect(meRes.status).toBe(401);
  });

  it('rejects wrong password with 401', async () => {
    const app = getApp();
    await createTestUser('wrong@test.com');
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'wrong@test.com', password: 'BadPassword' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('GET /auth/me', () => {
  it('returns profile with credits and keys count', async () => {
    const app = getApp();
    const user = await createTestUser('me@test.com');

    const res = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${user.managementKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.email).toBe('me@test.com');
    expect(body.data.plan).toBe('free');
    expect(body.data.credits_remaining).toBe(0);
    expect(body.data.keys_count).toBe(0);
  });

  it('rejects unauthorized with 401', async () => {
    const app = getApp();
    const res = await app.request('/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/rotate', () => {
  it('returns new key and invalidates old', async () => {
    const app = getApp();
    const user = await createTestUser('rotate@test.com');

    const res = await app.request('/auth/rotate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.managementKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.management_key).toMatch(/^sk-mgmt-/);
    expect(body.data.management_key).not.toBe(user.managementKey);
    expect(body.data.rotated_at).toBeTruthy();

    // Old key invalid
    const check = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${user.managementKey}` },
    });
    expect(check.status).toBe(401);

    // New key valid
    const check2 = await app.request('/auth/me', {
      headers: { Authorization: `Bearer ${body.data.management_key}` },
    });
    expect(check2.status).toBe(200);
  });
});
