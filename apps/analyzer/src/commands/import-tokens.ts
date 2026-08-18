import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { isValidSolanaAddress } from '@insiderscope/shared';
import type { AnalyzerCtx } from '../context';
import { upsertToken } from '../lib/persist';

/** Curated $10M+ list shipped with the repo (fixtures/tokens.seed.csv). */
const BUNDLED_SEED = fileURLToPath(new URL('../../../../fixtures/tokens.seed.csv', import.meta.url));

/**
 * Parse a candidate-token CSV and upsert every row.
 * Columns: mint[,symbol[,ath_mc_usd[,name]]]; header row optional; # comments allowed.
 */
async function importCsv(ctx: AnalyzerCtx, raw: string, label: string): Promise<number> {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  let imported = 0;
  let skipped = 0;
  for (const [i, line] of lines.entries()) {
    const cols = line.split(',').map((c) => c.trim());
    const [mint, symbol, athRaw, name] = cols;
    if (i === 0 && mint?.toLowerCase() === 'mint') continue; // header
    if (!mint || !isValidSolanaAddress(mint)) {
      ctx.log(`skip ${label} line ${i + 1}: invalid mint "${mint ?? ''}"`);
      skipped += 1;
      continue;
    }
    const ath = Number(athRaw);
    await upsertToken(ctx.db, {
      mint,
      symbol: symbol || null,
      name: name || null,
      athMcUsd: Number.isFinite(ath) && ath > 0 ? ath : null,
      athTs: Number.isFinite(ath) && ath > 0 ? new Date() : null,
      status: 'candidate',
    });
    imported += 1;
  }
  ctx.log(`import-tokens: ${imported} upserted, ${skipped} skipped from ${label}`);
  return imported;
}

/** CSV import — the MVP-primary way to seed candidate tokens. */
export async function runImportTokens(ctx: AnalyzerCtx, file: string): Promise<void> {
  // `pnpm analyzer …` runs with the package as cwd; resolve user paths against
  // the directory the command was actually invoked from.
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
  await importCsv(ctx, readFileSync(path, 'utf8'), file);
}

/**
 * Import every *.csv in the watch directory — the unattended path. Point
 * TOKENS_DIR at a persistent volume (default /data/tokens) and every pipeline
 * pass re-imports what's there; the files survive redeploys and imports are
 * upserts, so re-reading is a no-op.
 *
 * The repo's curated seed list is planted into the directory as seed.csv on the
 * first pass, so a fresh deployment has real candidates without anyone touching
 * a console. Edits to seed.csv (e.g. commenting tokens out) persist; deleting
 * the file restores the defaults on the next pass. Without a volume the bundled
 * seed is imported directly instead.
 */
export async function runImportDir(ctx: AnalyzerCtx, dir?: string): Promise<number> {
  const target = dir ?? ctx.cfg.TOKENS_DIR;
  const hasDir = !!target && existsSync(target) && statSync(target).isDirectory();

  if (!hasDir) {
    if (!existsSync(BUNDLED_SEED)) {
      ctx.log(`import-dir: ${target || '(unset)'} not present and no bundled seed — skipped`);
      return 0;
    }
    ctx.log(`import-dir: ${target || '(unset)'} not present — importing bundled seed list`);
    return importCsv(ctx, readFileSync(BUNDLED_SEED, 'utf8'), 'bundled seed');
  }

  const seedTarget = join(target, 'seed.csv');
  if (!existsSync(seedTarget) && existsSync(BUNDLED_SEED)) {
    try {
      copyFileSync(BUNDLED_SEED, seedTarget);
      ctx.log(`import-dir: planted curated seed list at ${seedTarget}`);
    } catch (err) {
      ctx.log(`import-dir: could not write ${seedTarget} (${err}) — importing bundled seed directly`);
      await importCsv(ctx, readFileSync(BUNDLED_SEED, 'utf8'), 'bundled seed');
    }
  }

  const files = readdirSync(target).filter((f) => f.toLowerCase().endsWith('.csv'));
  if (files.length === 0) {
    ctx.log(`import-dir: no .csv files in ${target}`);
    return 0;
  }
  let total = 0;
  for (const file of files) {
    try {
      total += await importCsv(ctx, readFileSync(join(target, file), 'utf8'), `${target}/${file}`);
    } catch (err) {
      ctx.log(`import-dir: ${file} failed — ${err instanceof Error ? err.message : err}`);
    }
  }
  return total;
}
