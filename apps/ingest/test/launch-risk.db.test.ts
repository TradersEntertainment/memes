import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type DbHandle } from '@insiderscope/db';
import type { HeliusClient } from '@insiderscope/shared';
import { assessLaunchRisk, deriveCurveTokenAccount, type LaunchRiskDeps } from '../src/launch-risk';

const url = process.env.DATABASE_URL;

// Real base58 mint so the curve/ATA PDAs derive (no tokens row needed).
const MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

describe.skipIf(!url)('assessLaunchRisk — supply-concentration bait detector', () => {
  let h: DbHandle;
  let curveAta: string;

  function deps(helius: HeliusClient | null): LaunchRiskDeps {
    return { db: h.db, helius, pumpCache: null, log: () => {}, solPriceFallbackUsd: null };
  }

  function heliusWith(accounts: { address: string; uiAmount: number | null }[]): HeliusClient {
    return { rpc: vi.fn(async () => ({ value: accounts })) } as unknown as HeliusClient;
  }

  beforeAll(async () => {
    h = createDb(url!, { max: 2 });
    curveAta = (await deriveCurveTokenAccount(MINT))!;
    expect(curveAta).toBeTruthy();
  });

  afterAll(async () => {
    await h.close();
  });

  it('flags a wallet holding most of the supply, ignoring the bonding curve account', async () => {
    const risk = await assessLaunchRisk(
      deps(
        heliusWith([
          { address: curveAta, uiAmount: 900_000_000 }, // the curve itself — excluded
          { address: 'BaiterWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAA', uiAmount: 790_000_000 },
          { address: 'Sma11Ho1derAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', uiAmount: 4_000_000 },
        ]),
      ),
      MINT,
    );
    expect(risk.top1Pct).toBeCloseTo(79, 0);
    expect(risk.risky).toBe(true);
    expect(risk.flags[0]).toContain('%79');
  });

  it('stays quiet for a healthy distribution', async () => {
    const risk = await assessLaunchRisk(
      deps(
        heliusWith([
          { address: curveAta, uiAmount: 800_000_000 },
          { address: 'Norma1BuyerAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', uiAmount: 30_000_000 }, // 3%
        ]),
      ),
      MINT,
    );
    expect(risk.top1Pct).toBeCloseTo(3, 0);
    expect(risk.flags).toEqual([]);
    expect(risk.risky).toBe(false);
  });

  it('returns no flags without Helius or on RPC failure — never a blocker', async () => {
    expect(await assessLaunchRisk(deps(null), MINT)).toMatchObject({
      flags: [],
      top1Pct: null,
      risky: false,
    });
    const failing = { rpc: vi.fn(async () => { throw new Error('boom'); }) } as unknown as HeliusClient;
    expect(await assessLaunchRisk(deps(failing), MINT)).toMatchObject({ flags: [], risky: false });
  });
});
