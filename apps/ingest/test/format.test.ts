import { describe, expect, it } from 'vitest';
import { formatRotationAlert, formatSwapAlert, fmtSol } from '../src/alerts/format';
import { FIX } from './fixtures';

const baseWallet = {
  address: FIX.watched,
  label: 'memelord',
  score: 84.2,
  bigTokenCount: 3,
};

describe('formatSwapAlert (Turkish)', () => {
  it('renders the full buy alert', () => {
    const text = formatSwapAlert({
      kind: 'buy',
      wallet: baseWallet,
      mint: FIX.mint,
      tokenSymbol: 'WIF',
      amountSol: 12.5,
      mcUsd: 45_300,
      secondsAfterLaunch: 240,
      rotated: null,
      signature: 'SigWebhookBuy1111111111111111111111111111111',
    });
    const lines = text.split('\n');
    // 4 minutes after launch = the run-and-buy moment → the loud header + buy links
    expect(lines[0]).toBe('🚀 <b>ERKEN GİRİŞ — INSIDER YENİ TOKEN ALDI</b>');
    expect(lines[1]).toBe('Cüzdan: memelord (Watc…AAAA) — skor 84, 3x winner');
    expect(lines[2]).toBe('Token: $WIF (Meme…pump)');
    expect(lines[3]).toBe('Miktar: 12.5 SOL | MC: $45.3K | Launch +4dk');
    expect(lines[4]).toBe('Rotated wallet: hayır');
    expect(lines[5]).toContain('https://dexscreener.com/solana/' + FIX.mint);
    expect(lines[5]).toContain('https://solscan.io/tx/SigWebhookBuy');
    expect(lines[5]).toContain('https://gmgn.ai/sol/token/' + FIX.mint);
    expect(lines[5]).toContain('https://jup.ag/swap/SOL-' + FIX.mint);
  });

  it('keeps the plain header (no buy links) for late, big-cap buys', () => {
    const text = formatSwapAlert({
      kind: 'buy',
      wallet: baseWallet,
      mint: FIX.mint,
      tokenSymbol: 'WIF',
      amountSol: 5,
      mcUsd: 12_000_000,
      secondsAfterLaunch: 86_400 * 30,
      rotated: null,
      signature: 'sig',
    });
    expect(text.startsWith('🚨 <b>INSIDER BUY</b>')).toBe(true);
    expect(text).not.toContain('jup.ag');
  });

  it('honors config-supplied fresh thresholds', () => {
    const base = {
      kind: 'buy' as const,
      wallet: baseWallet,
      mint: FIX.mint,
      tokenSymbol: null,
      amountSol: 1,
      mcUsd: 900_000,
      secondsAfterLaunch: null,
      rotated: null,
      signature: 'sig',
    };
    expect(formatSwapAlert(base)).toContain('ERKEN GİRİŞ'); // default $1M cap
    expect(formatSwapAlert({ ...base, freshMaxMcUsd: 500_000 })).toContain('INSIDER BUY');
  });

  it('marks rotated probation wallets with the parent', () => {
    const text = formatSwapAlert({
      kind: 'buy',
      wallet: { address: FIX.fresh, label: null, score: null, bigTokenCount: null },
      mint: FIX.mint,
      tokenSymbol: null,
      amountSol: 3,
      mcUsd: null,
      secondsAfterLaunch: null,
      rotated: { parent: FIX.watched },
      signature: 'sig',
    });
    expect(text).toContain('Rotated wallet: EVET (parent: Watc…AAAA)');
    expect(text).toContain('Cüzdan: Fres…AAAA');
    expect(text).toContain('MC: ?');
    expect(text).not.toContain('Launch');
  });

  it('renders sells with the sell header', () => {
    const text = formatSwapAlert({
      kind: 'sell',
      wallet: { ...baseWallet, bigTokenCount: 1 },
      mint: FIX.mint,
      tokenSymbol: 'WIF',
      amountSol: 8,
      mcUsd: 120_000,
      secondsAfterLaunch: 3900,
      rotated: null,
      signature: 'sig',
    });
    expect(text.startsWith('📉 <b>INSIDER SELL</b>')).toBe(true);
    expect(text).toContain('Miktar: 8 SOL | MC: $120K | Launch +1.1sa');
    expect(text).not.toContain('winner'); // 1 big token is not a repeat winner
  });

  it('escapes html in labels and symbols', () => {
    const text = formatSwapAlert({
      kind: 'buy',
      wallet: { ...baseWallet, label: '<b>evil&co</b>' },
      mint: FIX.mint,
      tokenSymbol: '<WIF>',
      amountSol: 1,
      mcUsd: null,
      secondsAfterLaunch: null,
      rotated: null,
      signature: 'sig',
    });
    expect(text).toContain('&lt;b&gt;evil&amp;co&lt;/b&gt;');
    expect(text).toContain('$&lt;WIF&gt;');
    expect(text).not.toContain('<b>evil');
  });
});

describe('formatRotationAlert', () => {
  it('renders the rotation notice', () => {
    const text = formatRotationAlert({
      parent: baseWallet,
      child: FIX.fresh,
      amountSol: 8,
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('ℹ️ <b>WALLET ROTATION</b>');
    expect(lines[1]).toBe('Kaynak: memelord (Watc…AAAA) — skor 84, 3x winner');
    expect(lines[2]).toBe('Hedef: Fres…AAAA — izlemeye alındı (probation)');
    expect(lines[3]).toBe('Miktar: 8 SOL');
    expect(lines[4]).toContain(`https://solscan.io/account/${FIX.fresh}`);
  });
});

describe('fmtSol', () => {
  it('formats SOL amounts sensibly', () => {
    expect(fmtSol(12.5)).toBe('12.5');
    expect(fmtSol(8)).toBe('8');
    expect(fmtSol(150.4)).toBe('150');
    expect(fmtSol(0.1234)).toBe('0.1234');
    expect(fmtSol(2.05)).toBe('2.05');
  });
});
