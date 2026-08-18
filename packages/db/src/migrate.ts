import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Apply the committed SQL migrations (packages/db/drizzle) programmatically.
 * Used by ingest at boot on deploy targets (Railway etc.) where nobody runs
 * drizzle-kit by hand. Idempotent — drizzle tracks applied migrations in its
 * journal table. Local dev can keep using `pnpm db:migrate`.
 */
export async function runMigrations(databaseUrl?: string): Promise<void> {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set — cannot run migrations');
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), {
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
