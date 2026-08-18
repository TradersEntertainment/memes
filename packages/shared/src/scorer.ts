import type { ScoreBreakdownJson, WalletTier } from '@insiderscope/db';
import type { ScoringConfig } from './config';
import { median } from './utils';

export interface PositionForScoring {
  mint: string;
  /** ATH market cap of the token, when known. */
  tokenAthMcUsd: number | null;
  creatorLinked: boolean;
  /** Entry delay for early positions; null for skeleton (full-history) positions. */
  secondsAfterLaunch: number | null;
  realizedPnlUsd: number | null;
  stillHolding: boolean | null;
  entryMcUsd: number | null;
}

export interface ScoringInput {
  positions: PositionForScoring[];
  /** Full swap-history trade count (survivorship countermeasure). May be a floor. */
  totalTrades: number;
}

export interface ScoreResult {
  score: number;
  tier: Exclude<WalletTier, 'probation'> | null;
  blacklistReason?: 'overtrading' | 'low-winrate' | 'sniper';
  breakdown: ScoreBreakdownJson;
}

/**
 * Composite insider score, 0-100:
 *   25 · repeat      — early in how many different $10M+ tokens (1→0.3, 2→0.7, 3+→1.0)
 *   25 · creatorLink — share of big-token positions with a creator/funding link
 *   20 · winRate     — Laplace-smoothed (wins+1)/(decided+2) over ALL traded tokens
 *   15 · selectivity — 1 - min(1, totalTrades/200); fewer trades = more selective
 *   15 · timing      — median entry delay; 5s-10min ideal, <3s is sniper-bot
 *                      territory UNLESS the wallet is creator-linked (dev bundles
 *                      are the truest insiders; generic snipers die on trade count)
 */
export function scoreWallet(input: ScoringInput, cfg: ScoringConfig): ScoreResult {
  const positions = input.positions;

  const bigPositions = positions.filter(
    (p) => (p.tokenAthMcUsd ?? 0) >= cfg.bigTokenMcUsd,
  );
  const bigTokenCount = new Set(bigPositions.map((p) => p.mint)).size;
  const repeatFactor =
    bigTokenCount >= 3 ? 1 : bigTokenCount === 2 ? 0.7 : bigTokenCount === 1 ? 0.3 : 0;

  const creatorLinkFactor =
    bigPositions.length > 0
      ? bigPositions.filter((p) => p.creatorLinked).length / bigPositions.length
      : 0;

  const decided = positions.filter((p) => p.realizedPnlUsd != null);
  const wins = decided.filter((p) => p.realizedPnlUsd! > 0).length;
  const winRate = (wins + 1) / (decided.length + 2); // Laplace smoothing

  const selectivityFactor = 1 - Math.min(1, input.totalTrades / cfg.maxTradesForSelectivity);

  const earlySeconds = positions
    .map((p) => p.secondsAfterLaunch)
    .filter((s): s is number => s != null);
  const medianEntrySeconds = median(earlySeconds);
  const anyCreatorLinked = positions.some((p) => p.creatorLinked);
  const timingFactor = computeTimingFactor(medianEntrySeconds, anyCreatorLinked, cfg);

  const points = {
    repeat: 25 * repeatFactor,
    creatorLink: 25 * creatorLinkFactor,
    winRate: 20 * winRate,
    selectivity: 15 * selectivityFactor,
    timing: 15 * timingFactor,
  };
  const score =
    points.repeat + points.creatorLink + points.winRate + points.selectivity + points.timing;

  let blacklistReason: ScoreResult['blacklistReason'];
  if (input.totalTrades > cfg.overtradeBlacklist) {
    blacklistReason = 'overtrading';
  } else if (decided.length >= cfg.minDecidedForWinRateBlacklist && winRate < cfg.minWinRate) {
    blacklistReason = 'low-winrate';
  } else if (
    medianEntrySeconds != null &&
    medianEntrySeconds < cfg.sniperSeconds &&
    !anyCreatorLinked
  ) {
    blacklistReason = 'sniper';
  }

  let tier: ScoreResult['tier'] = null;
  if (blacklistReason) {
    tier = 'blacklist';
  } else if (score >= cfg.insiderThreshold) {
    // small samples can't reach the top tier no matter the score
    tier = earlySeconds.length >= cfg.minScoredPositions ? 'insider' : 'watch';
  } else if (score >= cfg.watchThreshold) {
    tier = 'watch';
  }

  return {
    score: Math.round(score * 10) / 10,
    tier,
    blacklistReason,
    breakdown: {
      points,
      factors: { repeatFactor, creatorLinkFactor, winRate, selectivityFactor, timingFactor },
      medianEntrySeconds,
      bigTokenCount,
      decidedPositions: decided.length,
      earlyPositions: earlySeconds.length,
      ...(blacklistReason ? { blacklistReason } : {}),
      computedAt: new Date().toISOString(),
    },
  };
}

function computeTimingFactor(
  medianSeconds: number | null,
  creatorLinked: boolean,
  cfg: ScoringConfig,
): number {
  if (medianSeconds == null) return 0;
  if (medianSeconds < cfg.sniperSeconds) return creatorLinked ? 1 : 0;
  if (medianSeconds < 5) return 0.5;
  if (medianSeconds <= cfg.idealMaxSeconds) return 1;
  if (medianSeconds <= cfg.lateSeconds) {
    // linear 1.0 → 0.3 between 10min and 30min
    const t = (medianSeconds - cfg.idealMaxSeconds) / (cfg.lateSeconds - cfg.idealMaxSeconds);
    return 1 - t * 0.7;
  }
  return 0.1;
}
