import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from './client';

export async function migrate(sql: Sql) {
  // Ensure schema_migrations table exists
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Get applied versions
  const applied = await sql<{ version: number }[]>`
    SELECT version FROM schema_migrations ORDER BY version
  `;
  const appliedSet = new Set(applied.map((r) => r.version));

  // Read migration files
  const migrationsDir = join(import.meta.dir, 'migrations');
  const files = await readdir(migrationsDir);
  const sqlFiles = files
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of sqlFiles) {
    const version = parseInt(file.split('_')[0], 10);
    if (appliedSet.has(version)) continue;

    const content = await Bun.file(join(migrationsDir, file)).text();
    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`INSERT INTO schema_migrations (version) VALUES (${version})`;
    });
    console.log(`  Applied migration: ${file}`);
  }
}
