import { describe, expect, it } from 'vitest';
import type { ScoringConfig } from '../src/config';
import { scoreWallet, type PositionForScoring, type ScoringInput } from '../src/scorer';

const CFG: ScoringConfig = {
  bigTokenMcUsd: 10_000_000,
  maxTradesForSelectivity: 200,
  overtradeBlacklist: 500,
  minWinRate: 0.3,
  minDecidedForWinRateBlacklist: 5,
  sniperSeconds: 3,
  idealMaxSeconds: 600,
  lateSeconds: 1800,
  insiderThreshold: 70,
  watchThreshold: 50,
  minScoredPositions: 3,
};

let mintSeq = 0;
function pos(overrides: Partial<PositionForScoring> = {}): PositionForScoring {
  mintSeq += 1;
  return {
    mint: `mint-${mintSeq}`,
    tokenAthMcUsd: 20_000_000,
    creatorLinked: false,
    secondsAfterLaunch: 60,
    realizedPnlUsd: 1_000,
    stillHolding: false,
    entryMcUsd: 50_000,
    ...overrides,
  };
}

function score(input: Partial<ScoringInput>) {
  return scoreWallet({ positions: [], totalTrades: 10, ...input }, CFG);
}

describe('scoreWallet — factors', () => {
  it('maps big-token repeat count to 0/0.3/0.7/1.0', () => {
    expect(score({ positions: [] }).breakdown.factors.repeatFactor).toBe(0);
    expect(score({ positions: [pos()] }).breakdown.factors.repeatFactor).toBe(0.3);
    expect(score({ positions: [pos(), pos()] }).breakdown.factors.repeatFactor).toBe(0.7);
    expect(
      score({ positions: [pos(), pos(), pos(), pos()] }).breakdown.factors.repeatFactor,
    ).toBe(1);
  });

  it('ignores small tokens for the repeat factor but counts them for win rate', () => {
    const r = score({
      positions: [pos({ tokenAthMcUsd: 500_000, realizedPnlUsd: -50 }), pos()],
    });
    expect(r.breakdown.factors.repeatFactor).toBe(0.3);
    expect(r.breakdown.decidedPositions).toBe(2);
  });

  it('creator-link factor is the linked share of big-token positions', () => {
    const r = score({
      positions: [pos({ creatorLinked: true }), pos(), pos(), pos({ creatorLinked: true })],
    });
    expect(r.breakdown.factors.creatorLinkFactor).toBe(0.5);
  });

  it('win rate uses Laplace smoothing — one lucky trade is not 100%', () => {
    const oneWin = score({ positions: [pos({ realizedPnlUsd: 9_999 })] });
    expect(oneWin.breakdown.factors.winRate).toBeCloseTo((1 + 1) / (1 + 2), 9);
    const noDecided = score({ positions: [pos({ realizedPnlUsd: null })] });
    expect(noDecided.breakdown.factors.winRate).toBe(0.5);
    const twoWins = score({ positions: [pos(), pos()] });
    expect(twoWins.breakdown.factors.winRate).toBe(0.75);
  });

  it('selectivity decays with total trades', () => {
    expect(score({ totalTrades: 0 }).breakdown.factors.selectivityFactor).toBe(1);
    expect(score({ totalTrades: 100 }).breakdown.factors.selectivityFactor).toBe(0.5);
    expect(score({ totalTrades: 400 }).breakdown.factors.selectivityFactor).toBe(0);
  });

  it('timing: 5s-10min ideal, degrading to 30min, floor after', () => {
    const at = (s: number) =>
      score({ positions: [pos({ secondsAfterLaunch: s })] }).breakdown.factors.timingFactor;
    expect(at(60)).toBe(1);
    expect(at(600)).toBe(1);
    expect(at(4)).toBe(0.5);
    expect(at(1200)).toBeCloseTo(0.65, 9);
    expect(at(1800)).toBeCloseTo(0.3, 9);
    expect(at(3600)).toBe(0.1);
    expect(score({ positions: [pos({ secondsAfterLaunch: null })] }).breakdown.factors.timingFactor).toBe(0);
  });
});

describe('scoreWallet — sniper rule and blacklists', () => {
  it('median entry <3s zeroes timing and blacklists as sniper', () => {
    const r = score({ positions: [pos({ secondsAfterLaunch: 1.2 })] });
    expect(r.breakdown.factors.timingFactor).toBe(0);
    expect(r.tier).toBe('blacklist');
    expect(r.blacklistReason).toBe('sniper');
  });

  it('creator-linked wallets are exempt from the sniper rule (dev bundles)', () => {
    const r = score({
      positions: [pos({ secondsAfterLaunch: 0.8, creatorLinked: true })],
    });
    expect(r.breakdown.factors.timingFactor).toBe(1);
    expect(r.blacklistReason).toBeUndefined();
    expect(r.tier).not.toBe('blacklist');
  });

  it('blacklists overtraders regardless of everything else', () => {
    const r = score({
      positions: [pos({ creatorLinked: true }), pos(), pos(), pos()],
      totalTrades: 501,
    });
    expect(r.tier).toBe('blacklist');
    expect(r.blacklistReason).toBe('overtrading');
  });

  it('blacklists sustained low win rate but needs a minimum sample', () => {
    const losers = (n: number, wins: number) =>
      Array.from({ length: n }, (_, i) => pos({ realizedPnlUsd: i < wins ? 100 : -100 }));
    // 1 win / 5 decided → smoothed 2/7 ≈ 0.286 < 0.3
    expect(score({ positions: losers(5, 1) }).blacklistReason).toBe('low-winrate');
    // same ratio but only 4 decided → sample too small to condemn
    expect(score({ positions: losers(4, 0) }).blacklistReason).toBeUndefined();
  });
});

describe('scoreWallet — tiers', () => {
  it('a repeat creator-linked early buyer scores insider', () => {
    const positions = [
      pos({ creatorLinked: true, secondsAfterLaunch: 45 }),
      pos({ creatorLinked: true, secondsAfterLaunch: 120 }),
      pos({ creatorLinked: true, secondsAfterLaunch: 300 }),
      pos({ creatorLinked: true, secondsAfterLaunch: 90 }),
    ];
    const r = scoreWallet({ positions, totalTrades: 12 }, CFG);
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(r.tier).toBe('insider');
  });

  it('caps small samples at watch even with an insider-level score', () => {
    const positions = [
      pos({ creatorLinked: true, secondsAfterLaunch: 45 }),
      pos({ creatorLinked: true, secondsAfterLaunch: 120 }),
    ];
    const r = scoreWallet({ positions, totalTrades: 5 }, CFG);
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(r.tier).toBe('watch');
  });

  it('mid scores land in watch, low scores in no tier', () => {
    const mid = scoreWallet(
      {
        positions: [
          pos({ secondsAfterLaunch: 90 }),
          pos({ secondsAfterLaunch: 200, realizedPnlUsd: -10 }),
          pos({ secondsAfterLaunch: 400 }),
        ],
        totalTrades: 60,
      },
      CFG,
    );
    expect(mid.tier).toBe('watch');
    expect(mid.score).toBeGreaterThanOrEqual(50);
    expect(mid.score).toBeLessThan(70);

    const low = scoreWallet({ positions: [], totalTrades: 190 }, CFG);
    expect(low.tier).toBeNull();
  });

  it('score stays within 0-100 and the breakdown points sum to it', () => {
    const r = scoreWallet(
      {
        positions: Array.from({ length: 6 }, () =>
          pos({ creatorLinked: true, secondsAfterLaunch: 30 }),
        ),
        totalTrades: 1,
      },
      CFG,
    );
    const sum =
      r.breakdown.points.repeat +
      r.breakdown.points.creatorLink +
      r.breakdown.points.winRate +
      r.breakdown.points.selectivity +
      r.breakdown.points.timing;
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeCloseTo(Math.round(sum * 10) / 10, 6);
  });
});
