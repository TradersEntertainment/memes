import { eq, tokens, type Db } from '@insiderscope/db';
import {
  deriveBondingCurvePda,
  fmtUsdCompact,
  getLiveMcFromDexscreener,
  getSolPriceUsdNow,
  HeliusClient,
  pumpfunMcSol,
  PUMPFUN_TOTAL_SUPPLY,
} from '@insiderscope/shared';
import type { PumpCurveCache } from './pump-cache';

export interface LaunchRiskDeps {
  db: Db;
  helius: HeliusClient | null;
  pumpCache: PumpCurveCache | null;
  log: (msg: string) => void;
  solPriceFallbackUsd: number | null;
}

export interface LaunchRisk {
  /** Human-readable Turkish flag lines (empty = nothing suspicious found). */
  flags: string[];
  /** Largest non-curve holder's share of supply, percent. */
  top1Pct: number | null;
  risky: boolean;
}

interface LargestAccount {
  address: string;
  uiAmount: number | null;
}

const TOP_HOLDER_FLAG_PCT = 40;
const PAINT_AGE_MIN = 10;
const PAINT_MC_USD = 2_000_000;

/**
 * Cheap bait/MC-painting detector (first slice of spec 4.3): one
 * getTokenLargestAccounts call for supply concentration (the bonding curve's
 * own token account is excluded — pre-graduation it legitimately holds most of
 * the supply), plus an age-vs-market-cap sanity check ("$41.5M 39 seconds
 * after launch" is paint, not price discovery). Best-effort everywhere: no
 * Helius, RPC failure, or missing data → no flags, never a blocker.
 */
export async function assessLaunchRisk(deps: LaunchRiskDeps, mint: string): Promise<LaunchRisk> {
  const flags: string[] = [];
  let top1Pct: number | null = null;

  if (deps.helius) {
    try {
      const res = await deps.helius.rpc<{ value: LargestAccount[] }>('getTokenLargestAccounts', [
        mint,
      ]);
      const curveAta = await deriveCurveTokenAccount(mint);
      const holders = (res.value ?? []).filter(
        (a) => a.uiAmount != null && a.uiAmount > 0 && a.address !== curveAta,
      );
      const supply = await tokenSupply(deps, mint);
      const top = holders[0];
      if (top?.uiAmount != null && supply > 0) {
        top1Pct = (top.uiAmount / supply) * 100;
        if (top1Pct >= TOP_HOLDER_FLAG_PCT) {
          flags.push(`arzın %${top1Pct.toFixed(1)}'i tek cüzdanda`);
        }
      }
    } catch (err) {
      deps.log(`launch-risk ${mint.slice(0, 6)}…: holder check failed — ${err}`);
    }
  }

  try {
    const { ageMin, mcUsd } = await ageAndMc(deps, mint);
    if (ageMin != null && mcUsd != null && ageMin <= PAINT_AGE_MIN && mcUsd >= PAINT_MC_USD) {
      flags.push(
        `${Math.max(1, Math.round(ageMin))}dk'da ${fmtUsdCompact(mcUsd)} MC — boyama (fake pump) olası`,
      );
    }
  } catch (err) {
    deps.log(`launch-risk ${mint.slice(0, 6)}…: mc check failed — ${err}`);
  }

  return { flags, top1Pct, risky: flags.length > 0 };
}

/** The bonding curve PDA's associated token account (what actually holds supply). */
export async function deriveCurveTokenAccount(mint: string): Promise<string | null> {
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const curve = new PublicKey(deriveBondingCurvePda(mint));
    const [ata] = PublicKey.findProgramAddressSync(
      [curve.toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()],
      ATA_PROGRAM,
    );
    return ata.toBase58();
  } catch {
    return null;
  }
}

async function tokenSupply(deps: LaunchRiskDeps, mint: string): Promise<number> {
  const row = (await deps.db.select().from(tokens).where(eq(tokens.mint, mint)).limit(1))[0];
  if (row?.launchPlatform && row.launchPlatform !== 'pumpfun' && deps.helius) {
    return deps.helius
      .getTokenSupply(mint)
      .then((s) => s.uiAmount || PUMPFUN_TOTAL_SUPPLY)
      .catch(() => PUMPFUN_TOTAL_SUPPLY);
  }
  return PUMPFUN_TOTAL_SUPPLY;
}

async function ageAndMc(
  deps: LaunchRiskDeps,
  mint: string,
): Promise<{ ageMin: number | null; mcUsd: number | null }> {
  const row = (await deps.db.select().from(tokens).where(eq(tokens.mint, mint)).limit(1))[0];
  const cached = await deps.pumpCache?.get(mint);
  const launchTs = row?.launchTs ?? cached?.launchTs ?? null;
  const ageMin = launchTs ? (Date.now() - launchTs.getTime()) / 60_000 : null;
  // The paint flag needs BOTH a young age and a big cap — when the age already
  // disqualifies it, skip the market-cap lookup entirely.
  if (ageMin == null || ageMin > PAINT_AGE_MIN) return { ageMin, mcUsd: null };

  let mcUsd: number | null = null;
  if (cached && cached.vTokens > 0) {
    const solUsd = await getSolPriceUsdNow({ fallbackUsd: deps.solPriceFallbackUsd });
    if (solUsd != null) mcUsd = pumpfunMcSol(cached.vSol, cached.vTokens) * solUsd;
  }
  if (mcUsd == null) {
    const live = await getLiveMcFromDexscreener(mint);
    mcUsd = live?.mcUsd ?? null;
  }
  return { ageMin, mcUsd };
}
