import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, inArray, tokens, type DbHandle } from '@insiderscope/db';
import { getConfig, resetConfigCache } from '@insiderscope/shared';
import { runImportDir } from '../src/commands/import-tokens';
import type { AnalyzerCtx } from '../src/context';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('runImportDir — seed planting + idempotent imports', () => {
  let h: DbHandle;
  let dir: string;
  const imported: string[] = [];

  function ctx(): AnalyzerCtx {
    resetConfigCache();
    return {
      db: h.db,
      cfg: getConfig(),
      log: () => {},
      get helius(): never {
        throw new Error('helius must not be touched by imports');
      },
    } as AnalyzerCtx;
  }

  beforeAll(() => {
    h = createDb(url!, { max: 2 });
    dir = mkdtempSync(join(tmpdir(), 'is-tokens-'));
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    if (imported.length > 0) {
      await h.db.delete(tokens).where(inArray(tokens.mint, imported));
    }
    await h.close();
  });

  it('plants the bundled seed into an empty dir and imports it', async () => {
    const count = await runImportDir(ctx(), dir);
    expect(count).toBeGreaterThanOrEqual(15);

    const seed = readFileSync(join(dir, 'seed.csv'), 'utf8');
    expect(seed).toContain('FARTCOIN');
    for (const line of seed.split('\n')) {
      const mint = line.split(',')[0]?.trim();
      if (mint && !mint.startsWith('#') && mint !== 'mint') imported.push(mint);
    }
  });

  it('re-running imports the same rows without duplicating, and extra csvs are picked up', async () => {
    writeFileSync(
      join(dir, 'own.csv'),
      'mint,symbol,ath_mc_usd\nJUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN,JUP,2000000000\n',
    );
    imported.push('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');

    const count = await runImportDir(ctx(), dir);
    const rows = await h.db.select().from(tokens).where(inArray(tokens.mint, imported));
    expect(count).toBe(rows.length); // every csv row upserted exactly once
    expect(rows.map((r) => r.symbol)).toContain('JUP');
  });

  it('respects commented-out lines in an edited seed.csv', async () => {
    const seedPath = join(dir, 'seed.csv');
    const edited = readFileSync(seedPath, 'utf8').replace(/^EKpQ/m, '# EKpQ'); // disable WIF
    writeFileSync(seedPath, edited);

    const before = await runImportDir(ctx(), dir);
    expect(readFileSync(seedPath, 'utf8')).toContain('# EKpQ'); // edits survive the pass
    const again = await runImportDir(ctx(), dir);
    expect(again).toBe(before);
  });
});
