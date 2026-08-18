import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadFixture<T = unknown>(relPath: string): T {
  const abs = fileURLToPath(new URL(`../../../fixtures/${relPath}`, import.meta.url));
  return JSON.parse(readFileSync(abs, 'utf8')) as T;
}

export const FIX = {
  mint: 'MemeCoinMintAAAAAAAAAAAAAAAAAAAAAAAAAAAApump',
  watched: 'WatchedWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  fresh: 'FreshRotationTargetAAAAAAAAAAAAAAAAAAAAAAAAA',
} as const;
