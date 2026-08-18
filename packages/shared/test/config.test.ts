import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getConfig, resetConfigCache, scoringConfig } from '../src/config';

const TOUCHED = ['EARLY_WINDOW_MIN', 'SELL_ALERTS', 'TRANSFER_MIN_SOL', 'SOL_PRICE_FALLBACK_USD'];

describe('config', () => {
  beforeEach(() => {
    for (const key of TOUCHED) delete process.env[key];
    resetConfigCache();
  });

  afterEach(() => {
    for (const key of TOUCHED) delete process.env[key];
    resetConfigCache();
  });

  it('applies defaults when env vars are absent', () => {
    resetConfigCache();
    const cfg = getConfig();
    expect(cfg.EARLY_WINDOW_MIN).toBe(30);
    expect(cfg.EARLY_MAX_BUYERS).toBe(150);
    expect(cfg.TRANSFER_MIN_SOL).toBe(5);
    expect(cfg.SELL_ALERTS).toBe(true);
    expect(cfg.SOL_PRICE_FALLBACK_USD).toBeNull();
  });

  it('parses overrides including booleans and optional numbers', () => {
    process.env.EARLY_WINDOW_MIN = '10';
    process.env.SELL_ALERTS = 'false';
    process.env.TRANSFER_MIN_SOL = '2.5';
    process.env.SOL_PRICE_FALLBACK_USD = '150';
    resetConfigCache();
    const cfg = getConfig();
    expect(cfg.EARLY_WINDOW_MIN).toBe(10);
    expect(cfg.SELL_ALERTS).toBe(false);
    expect(cfg.TRANSFER_MIN_SOL).toBe(2.5);
    expect(cfg.SOL_PRICE_FALLBACK_USD).toBe(150);
  });

  it('derives scoring config with spec thresholds', () => {
    resetConfigCache();
    const s = scoringConfig(getConfig());
    expect(s.bigTokenMcUsd).toBe(10_000_000);
    expect(s.overtradeBlacklist).toBe(500);
    expect(s.sniperSeconds).toBe(3);
    expect(s.insiderThreshold).toBe(70);
    expect(s.watchThreshold).toBe(50);
  });
});
