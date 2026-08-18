import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

/** Create an isolated connection pool (tests, one-off scripts). */
export function createDb(url: string, opts?: { max?: number }): DbHandle {
  const sql = postgres(url, {
    max: opts?.max ?? 10,
    onnotice: () => {},
  });
  return {
    db: drizzle(sql, { schema }),
    close: () => sql.end({ timeout: 5 }),
  };
}

let singleton: DbHandle | null = null;

/** Lazy process-wide singleton reading DATABASE_URL (call after env is loaded). */
export function getDb(): Db {
  if (!singleton) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is not set — configure it in .env');
    }
    singleton = createDb(url);
  }
  return singleton.db;
}

export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.close();
    singleton = null;
  }
}
