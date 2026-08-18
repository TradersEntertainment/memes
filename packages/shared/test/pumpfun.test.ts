import { describe, expect, it } from 'vitest';
import { deriveBondingCurvePda, pumpfunMcSol } from '../src/pumpfun';

describe('pump.fun helpers', () => {
  it('derives the bonding curve PDA (pinned regression vector)', () => {
    // Fartcoin mint — PDA precomputed once with @solana/web3.js and pinned so
    // accidental seed/program changes fail loudly.
    expect(deriveBondingCurvePda('9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump')).toBe(
      'TBHe5tJnuT4CQbHorJ1uVdfUoaYGPKgfCpiv2jgesVN',
    );
  });

  it('is deterministic and mint-dependent', () => {
    const a = deriveBondingCurvePda('9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump');
    const b = deriveBondingCurvePda('So11111111111111111111111111111111111111112');
    expect(a).toBe(deriveBondingCurvePda('9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'));
    expect(a).not.toBe(b);
  });

  it('computes market cap in SOL from virtual reserves', () => {
    // price = 30 vSOL / 1_000_000_000 vTokens → MC = price * 1B supply = 30 SOL
    expect(pumpfunMcSol(30, 1_000_000_000)).toBeCloseTo(30, 9);
    expect(pumpfunMcSol(85, 250_000_000)).toBeCloseTo(340, 9);
    expect(pumpfunMcSol(30, 0)).toBe(0);
  });
});
