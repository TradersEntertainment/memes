import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Load a JSON fixture from the repo-root fixtures/ directory. */
export function loadFixture<T = unknown>(relPath: string): T {
  const abs = fileURLToPath(new URL(`../../../fixtures/${relPath}`, import.meta.url));
  return JSON.parse(readFileSync(abs, 'utf8')) as T;
}

// Canonical fixture addresses (shared across helius fixture files).
export const FIX = {
  mint: 'MemeCoinMintAAAAAAAAAAAAAAAAAAAAAAAAAAAApump',
  curve: 'BondingCurvePdaAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  creator: 'CreatorDevAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  buyer1: 'FirstBuyerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  buyer2: 'SecondBuyerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  buyer3: 'ThirdBuyerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  watched: 'WatchedWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  fresh: 'FreshRotationTargetAAAAAAAAAAAAAAAAAAAAAAAAA',
  randomTrader: 'RandomTraderAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
} as const;
