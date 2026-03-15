import postgres from 'postgres';
import { config } from '../config';

export function createDb(url?: string) {
  return postgres(url || config.databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export type Sql = ReturnType<typeof createDb>;
