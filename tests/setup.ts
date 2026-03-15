import { createDb, type Sql } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { createApp } from '../src/app';
import type { Hono } from 'hono';

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/openclaw_token_test';

let sql: Sql;
let app: Hono;

export async function setupTestDb() {
  sql = createDb(TEST_DB_URL);
  await migrate(sql);
  app = createApp(sql);
  return { sql, app };
}

export async function cleanupTestDb() {
  if (sql) {
    // Clean all tables in reverse dependency order
    await sql`DELETE FROM credit_transactions`;
    await sql`DELETE FROM credit_balances`;
    await sql`DELETE FROM oauth_sessions`;
    await sql`DELETE FROM provisioned_keys`;
    await sql`DELETE FROM management_keys`;
    await sql`DELETE FROM users`;
  }
}

export async function teardownTestDb() {
  if (sql) await sql.end();
}

export function getApp() { return app; }
export function getSql() { return sql; }

export async function createTestUser(email = 'test@example.com', password = 'TestPass123!') {
  const res = await app.request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json() as any;
  return {
    email,
    managementKey: body.data.management_key,
  };
}
