import { and, eq, gte, lte, solPrices, sql, type Db } from '@insiderscope/db';
import { BINANCE_API_BASE, COINBASE_API_BASE, COINBASE_EXCHANGE_API_BASE } from './constants';
import { chunk, hourFloor } from './utils';

export interface SolPriceOptions {
  fetchImpl?: typeof fetch;
  /** Last resort when every provider is unreachable and no candle is cached nearby. */
  fallbackUsd?: number | null;
}

interface HourlyCandle {
  tsMs: number;
  closeUsd: number;
}

interface PriceProvider {
  name: string;
  fetchHourly(fromMs: number, toMs: number, fetchImpl: typeof fetch): Promise<HourlyCandle[]>;
  fetchSpot(fetchImpl: typeof fetch): Promise<number | null>;
}

/**
 * Coinbase is tried first: Binance blocks US IPs with HTTP 451, and cloud
 * providers (Railway, Fly, Render) commonly run there. Binance stays as the
 * fallback for regions where Coinbase is the restricted one.
 */
const coinbase: PriceProvider = {
  name: 'coinbase',
  async fetchHourly(fromMs, toMs, fetchImpl) {
    const url =
      `${COINBASE_EXCHANGE_API_BASE}/products/SOL-USD/candles?granularity=3600` +
      `&start=${new Date(fromMs).toISOString()}&end=${new Date(toMs).toISOString()}`;
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'insiderscope' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`coinbase candles ${res.status}`);
    const rows = (await res.json()) as [number, number, number, number, number, number][];
    // [ time(seconds), low, high, open, close, volume ]
    return rows
      .map((r) => ({ tsMs: Number(r[0]) * 1000, closeUsd: Number(r[4]) }))
      .filter((c) => Number.isFinite(c.tsMs) && Number.isFinite(c.closeUsd) && c.closeUsd > 0);
  },
  async fetchSpot(fetchImpl) {
    const res = await fetchImpl(`${COINBASE_API_BASE}/v2/prices/SOL-USD/spot`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`coinbase spot ${res.status}`);
    const body = (await res.json()) as { data?: { amount?: string } };
    const price = Number(body.data?.amount);
    return Number.isFinite(price) && price > 0 ? price : null;
  },
};

const binance: PriceProvider = {
  name: 'binance',
  async fetchHourly(fromMs, toMs, fetchImpl) {
    const url =
      `${BINANCE_API_BASE}/api/v3/klines?symbol=SOLUSDT&interval=1h` +
      `&startTime=${fromMs}&endTime=${toMs}&limit=1000`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`binance klines ${res.status}`);
    const rows = (await res.json()) as [number, string, string, string, string, ...unknown[]][];
    // [ openTime(ms), open, high, low, close, ... ]
    return rows
      .map((r) => ({ tsMs: Number(r[0]), closeUsd: Number(r[4]) }))
      .filter((c) => Number.isFinite(c.tsMs) && Number.isFinite(c.closeUsd) && c.closeUsd > 0);
  },
  async fetchSpot(fetchImpl) {
    const res = await fetchImpl(`${BINANCE_API_BASE}/api/v3/ticker/price?symbol=SOLUSDT`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`binance ticker ${res.status}`);
    const body = (await res.json()) as { price?: string };
    const price = Number(body.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  },
};

const PROVIDERS: PriceProvider[] = [coinbase, binance];
/** Coinbase caps a candle request at 300; keep chunks under that for every provider. */
const CHUNK_HOURS = 288;
const HOUR_MS = 3_600_000;

// Remember which provider answered so a geo-blocked one isn't retried per chunk.
let preferred: PriceProvider | null = null;
let nowCache: { price: number; fetchedAt: number } | null = null;

function ordered(): PriceProvider[] {
  if (!preferred) return PROVIDERS;
  return [preferred, ...PROVIDERS.filter((p) => p !== preferred)];
}

async function fetchHourlyAny(
  fromMs: number,
  toMs: number,
  fetchImpl: typeof fetch,
): Promise<HourlyCandle[]> {
  const errors: string[] = [];
  for (const provider of ordered()) {
    try {
      const candles = await provider.fetchHourly(fromMs, toMs, fetchImpl);
      preferred = provider;
      return candles;
    } catch (err) {
      errors.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`no SOL price provider reachable (${errors.join('; ')})`);
}

/** Spot SOL/USD with a 60s in-memory cache. */
export async function getSolPriceUsdNow(opts: SolPriceOptions = {}): Promise<number | null> {
  if (nowCache && Date.now() - nowCache.fetchedAt < 60_000) return nowCache.price;
  const fetchImpl = opts.fetchImpl ?? fetch;
  for (const provider of ordered()) {
    try {
      const price = await provider.fetchSpot(fetchImpl);
      if (price != null) {
        preferred = provider;
        nowCache = { price, fetchedAt: Date.now() };
        return price;
      }
    } catch {
      // try the next provider
    }
  }
  return opts.fallbackUsd ?? null;
}

/** Test hook. */
export function resetSolPriceMemoryCache(): void {
  nowCache = null;
  preferred = null;
}

async function storeCandles(db: Db, candles: HourlyCandle[]): Promise<void> {
  const rows = candles.map((c) => ({ ts: new Date(c.tsMs), priceUsd: c.closeUsd }));
  for (const group of chunk(rows, 500)) {
    if (group.length > 0) {
      await db.insert(solPrices).values(group).onConflictDoNothing();
    }
  }
}

/**
 * Backfill the hourly SOL/USD cache for a time range (inclusive), chunked to the
 * strictest provider limit. Cheap to call repeatedly — already-cached chunks are
 * skipped without a network call.
 */
export async function ensureSolPriceRange(
  db: Db,
  from: Date,
  to: Date,
  opts: SolPriceOptions = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const start = hourFloor(from).getTime();
  const end = hourFloor(to).getTime();
  for (let cursor = start; cursor <= end; cursor += CHUNK_HOURS * HOUR_MS) {
    const chunkEnd = Math.min(cursor + (CHUNK_HOURS - 1) * HOUR_MS, end);
    const cached = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(solPrices)
      .where(and(gte(solPrices.ts, new Date(cursor)), lte(solPrices.ts, new Date(chunkEnd))));
    const expected = Math.floor((chunkEnd - cursor) / HOUR_MS) + 1;
    if ((cached[0]?.n ?? 0) >= expected) continue;
    await storeCandles(db, await fetchHourlyAny(cursor, chunkEnd, fetchImpl));
  }
}

/**
 * SOL/USD price at a historical instant (hour resolution). Order: exact cached
 * hour → provider backfill (±2h window) → nearest cached hour within 48h →
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
    await storeCandles(
      db,
      await fetchHourlyAny(floor.getTime() - 2 * HOUR_MS, floor.getTime() + 2 * HOUR_MS, fetchImpl),
    );
  } catch {
    // every provider unreachable — fall through to the nearest cached hour
  }

  const after = await db.select().from(solPrices).where(eq(solPrices.ts, floor)).limit(1);
  if (after[0]) return after[0].priceUsd;

  const floorEpoch = Math.floor(floor.getTime() / 1000);
  const nearest = await db
    .select()
    .from(solPrices)
    .where(
      and(
        gte(solPrices.ts, new Date(floor.getTime() - 48 * HOUR_MS)),
        lte(solPrices.ts, new Date(floor.getTime() + 48 * HOUR_MS)),
      ),
    )
    .orderBy(sql`abs(extract(epoch from ${solPrices.ts}) - ${floorEpoch})`)
    .limit(1);
  if (nearest[0]) return nearest[0].priceUsd;

  return opts.fallbackUsd ?? null;
}
