import { eq, tokens, type Db, type TokenRow } from '@insiderscope/db';
import {
  deriveBondingCurvePda,
  getLiveMcFromDexscreener,
  getSolPriceUsdNow,
  HeliusClient,
  pumpfunMcSol,
  PUMPFUN_TOTAL_SUPPLY,
  swapDerivedMcSol,
  type AppConfig,
  type NormalizedSwap,
} from '@insiderscope/shared';
import type { PumpCurveCache } from '../pump-cache';

export interface EnrichCtx {
  db: Db;
  cfg: AppConfig;
  helius: HeliusClient | null;
  pumpCache: PumpCurveCache | null;
  log: (msg: string) => void;
}

/**
 * Live market cap resolution chain: DexScreener (once listed) → PumpPortal
 * bonding-curve state (pre-listing) → derived from the swap itself (always
 * available). Alerts fire within seconds of launch, so the fallbacks matter.
 */
export function makeResolveMc(ctx: EnrichCtx) {
  return async (
    mint: string,
    swap: NormalizedSwap,
  ): Promise<{ mcUsd: number | null; source: string }> => {
    const ds = await getLiveMcFromDexscreener(mint);
    if (ds) return { mcUsd: ds.mcUsd, source: 'dexscreener' };

    const priceOpts = { fallbackUsd: ctx.cfg.SOL_PRICE_FALLBACK_USD };
    const curve = await ctx.pumpCache?.get(mint);
    if (curve && curve.vTokens > 0) {
      const solUsd = await getSolPriceUsdNow(priceOpts);
      if (solUsd != null) {
        return { mcUsd: pumpfunMcSol(curve.vSol, curve.vTokens) * solUsd, source: 'pumpportal' };
      }
    }

    const token = await getTokenRow(ctx.db, mint);
    let supply = PUMPFUN_TOTAL_SUPPLY;
    if (token?.launchPlatform && token.launchPlatform !== 'pumpfun' && ctx.helius) {
      supply = await ctx.helius
        .getTokenSupply(mint)
        .then((s) => s.uiAmount || PUMPFUN_TOTAL_SUPPLY)
        .catch(() => PUMPFUN_TOTAL_SUPPLY);
    }
    const mcSol = swapDerivedMcSol(swap.solAmount, swap.tokenAmount, supply);
    const solUsd = await getSolPriceUsdNow(priceOpts);
    if (mcSol != null && solUsd != null) {
      return { mcUsd: mcSol * solUsd, source: 'swap' };
    }
    return { mcUsd: null, source: 'none' };
  };
}

async function getTokenRow(db: Db, mint: string): Promise<TokenRow | null> {
  const rows = await db.select().from(tokens).where(eq(tokens.mint, mint)).limit(1);
  return rows[0] ?? null;
}

/**
 * Make sure a token row exists for a mint a watched wallet just traded, seeding
 * launch metadata from the PumpPortal cache when we have it. Returns what the
 * alert formatter needs (symbol + launch time).
 */
export async function ensureTokenMeta(
  ctx: Pick<EnrichCtx, 'db' | 'pumpCache'>,
  mint: string,
): Promise<{ symbol: string | null; launchTs: Date | null }> {
  const existing = await getTokenRow(ctx.db, mint);
  if (existing?.launchTs || (existing?.symbol && !ctx.pumpCache)) {
    return { symbol: existing.symbol, launchTs: existing.launchTs };
  }

  const cached = await ctx.pumpCache?.get(mint);
  if (!existing && !cached) return { symbol: null, launchTs: null };

  const symbol = existing?.symbol ?? cached?.symbol ?? null;
  const launchTs = existing?.launchTs ?? cached?.launchTs ?? null;
  await ctx.db
    .insert(tokens)
    .values({
      mint,
      symbol,
      name: cached?.name ?? null,
      creatorWallet: cached?.creator ?? null,
      launchPlatform: cached ? 'pumpfun' : null,
      launchTs,
      bondingCurve: cached ? deriveBondingCurvePda(mint) : null,
      status: 'candidate',
    })
    .onConflictDoUpdate({
      target: tokens.mint,
      set: {
        symbol: symbol ?? undefined,
        launchTs: launchTs ?? undefined,
        creatorWallet: cached?.creator ?? undefined,
      },
    });
  return { symbol, launchTs };
}
