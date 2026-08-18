import { describe, expect, it } from 'vitest';
import {
  chunk,
  escapeHtml,
  fmtLaunchDeltaTr,
  fmtUsdCompact,
  hourFloor,
  isValidSolanaAddress,
  lamportsToSol,
  median,
  shortAddr,
} from '../src/utils';

describe('utils', () => {
  it('lamportsToSol handles numbers and strings', () => {
    expect(lamportsToSol(2_500_000_000)).toBe(2.5);
    expect(lamportsToSol('100000000')).toBe(0.1);
  });

  it('shortAddr truncates long addresses', () => {
    expect(shortAddr('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe('9WzD…AWWM');
    expect(shortAddr('short')).toBe('short');
  });

  it('validates solana addresses loosely', () => {
    expect(isValidSolanaAddress('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe(true);
    expect(isValidSolanaAddress('not-an-address')).toBe(false);
    expect(isValidSolanaAddress('0OIl' + 'a'.repeat(30))).toBe(false);
  });

  it('median of even/odd/empty lists', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('chunk splits arrays', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('hourFloor floors to the UTC hour', () => {
    expect(hourFloor(new Date('2026-03-01T13:45:59.123Z')).toISOString()).toBe(
      '2026-03-01T13:00:00.000Z',
    );
  });

  it('escapes html', () => {
    expect(escapeHtml('<b>&"x"</b>')).toBe('&lt;b&gt;&amp;"x"&lt;/b&gt;');
  });

  it('formats compact usd', () => {
    expect(fmtUsdCompact(45_300)).toBe('$45.3K');
    expect(fmtUsdCompact(1_240_000)).toBe('$1.2M');
    expect(fmtUsdCompact(999)).toBe('$999');
    expect(fmtUsdCompact(3.456)).toBe('$3.46');
    expect(fmtUsdCompact(-12_000)).toBe('-$12K');
    expect(fmtUsdCompact(null)).toBe('?');
  });

  it('formats turkish launch deltas', () => {
    expect(fmtLaunchDeltaTr(38)).toBe('+38sn');
    expect(fmtLaunchDeltaTr(240)).toBe('+4dk');
    expect(fmtLaunchDeltaTr(7200)).toBe('+2sa');
    expect(fmtLaunchDeltaTr(null)).toBeNull();
  });
});
