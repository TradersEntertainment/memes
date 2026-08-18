import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isValidSolanaAddress } from '@insiderscope/shared';
import type { AnalyzerCtx } from '../context';
import { upsertToken } from '../lib/persist';

/**
 * CSV import — the MVP-primary way to seed candidate tokens.
 * Columns: mint[,symbol[,ath_mc_usd[,name]]]; header row optional; # comments allowed.
 */
export async function runImportTokens(ctx: AnalyzerCtx, file: string): Promise<void> {
  // `pnpm analyzer …` runs with the package as cwd; resolve user paths against
  // the directory the command was actually invoked from.
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
  const raw = readFileSync(path, 'utf8');
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
      ctx.log(`skip line ${i + 1}: invalid mint "${mint ?? ''}"`);
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
  ctx.log(`import-tokens: ${imported} upserted, ${skipped} skipped from ${file}`);
}
