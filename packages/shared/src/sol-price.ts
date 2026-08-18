import { and, eq, gte, lte, solPrices, sql, type Db } from '@insiderscope/db';
import { BINANCE_API_BASE } from './constants';
import { chunk, hourFloor } from './utils';

type Kline = [number, string, string, string, string, ...unknown[]];

export interface SolPriceOptions {
  fetchImpl?: typeof fetch;
  /** Used when Binance is unreachable and no cached candle is close enough. */
  fallbackUsd?: number | null;
}

let nowCache: { price: number; fetchedAt: number } | null = null;

/** Spot SOL/USD with a 60s in-memory cache. */
export async function getSolPriceUsdNow(opts: SolPriceOptions = {}): Promise<number | null> {
  if (nowCache && Date.now() - nowCache.fetchedAt < 60_000) return nowCache.price;
  try {
    const res = await (opts.fetchImpl ?? fetch)(
      `${BINANCE_API_BASE}/api/v3/ticker/price?symbol=SOLUSDT`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (res.ok) {
      const body = (await res.json()) as { price?: string };
      const price = Number(body.price);
      if (Number.isFinite(price) && price > 0) {
        nowCache = { price, fetchedAt: Date.now() };
        return price;
      }
    }
  } catch {
    // fall through to fallback
  }
  return opts.fallbackUsd ?? null;
}

/** Test hook. */
export function resetSolPriceMemoryCache(): void {
  nowCache = null;
}

async function fetchKlines(
  fromMs: number,
  toMs: number,
  fetchImpl: typeof fetch,
): Promise<Kline[]> {
  const res = await fetchImpl(
    `${BINANCE_API_BASE}/api/v3/klines?symbol=SOLUSDT&interval=1h&startTime=${fromMs}&endTime=${toMs}&limit=1000`,
    { signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`binance klines ${res.status}`);
  return (await res.json()) as Kline[];
}

async function storeKlines(db: Db, klines: Kline[]): Promise<void> {
  const rows = klines
    .map((k) => ({ ts: new Date(k[0]), priceUsd: Number(k[4]) }))
    .filter((r) => Number.isFinite(r.priceUsd) && r.priceUsd > 0);
  for (const group of chunk(rows, 500)) {
    if (group.length > 0) {
      await db.insert(solPrices).values(group).onConflictDoNothing();
    }
  }
}

/**
 * Backfill the hourly SOL/USD cache for a time range (inclusive), chunked to
 * Binance's 1000-candle limit. Cheap to call repeatedly — cached hours are skipped
 * by the primary-key conflict.
 */
export async function ensureSolPriceRange(
  db: Db,
  from: Date,
  to: Date,
  opts: SolPriceOptions = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const HOUR = 3600_000;
  const start = hourFloor(from).getTime();
  const end = hourFloor(to).getTime();
  for (let cursor = start; cursor <= end; cursor += 1000 * HOUR) {
    const chunkEnd = Math.min(cursor + 999 * HOUR, end);
    const cached = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(solPrices)
      .where(and(gte(solPrices.ts, new Date(cursor)), lte(solPrices.ts, new Date(chunkEnd))));
    const expected = Math.floor((chunkEnd - cursor) / HOUR) + 1;
    if ((cached[0]?.n ?? 0) >= expected) continue;
    const klines = await fetchKlines(cursor, chunkEnd + HOUR - 1, fetchImpl);
    await storeKlines(db, klines);
  }
}

/**
 * SOL/USD price at a historical instant (hour resolution). Order: exact cached
 * hour → Binance backfill (±2h window) → nearest cached hour within 48h →
 * configured fallback → null.
 */
export async function getSolPriceUsdAt(
  db: Db,
  ts: Date,
  opts: SolPriceOptions = {},
): Promise<number | null> {
  const floor = hourFloor(ts);

  const exact = await db.select().from(solPrices).where(eq(solPrices.ts, floor)).limit(1);
  if (exact[0]) return exact[0].priceUsd;

  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const klines = await fetchKlines(
      floor.getTime() - 2 * 3600_000,
      floor.getTime() + 2 * 3600_000,
      fetchImpl,
    );
    await storeKlines(db, klines);
  } catch {
    // offline / geo-blocked — try nearest below
  }

  const after = await db.select().from(solPrices).where(eq(solPrices.ts, floor)).limit(1);
  if (after[0]) return after[0].priceUsd;

  const floorEpoch = Math.floor(floor.getTime() / 1000);
  const nearest = await db
    .select()
    .from(solPrices)
    .where(
      and(
        gte(solPrices.ts, new Date(floor.getTime() - 48 * 3600_000)),
        lte(solPrices.ts, new Date(floor.getTime() + 48 * 3600_000)),
      ),
    )
    .orderBy(sql`abs(extract(epoch from ${solPrices.ts}) - ${floorEpoch})`)
    .limit(1);
  if (nearest[0]) return nearest[0].priceUsd;

  return opts.fallbackUsd ?? null;
}
