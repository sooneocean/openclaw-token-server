import { createDb } from './db/client';
import { migrate } from './db/migrate';
import { config } from './config';
import { createApp } from './app';

async function main() {
  const sql = createDb();

  console.log('Running migrations...');
  await migrate(sql);
  console.log('Migrations complete.');

  const app = createApp(sql);

  console.log(`Server listening on port ${config.port}`);
  Bun.serve({
    fetch: app.fetch,
    port: config.port,
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
