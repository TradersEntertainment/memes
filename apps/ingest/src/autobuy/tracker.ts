import { and, desc, eq, gte, lt, paperTrades, sql, tokens, type Db } from '@insiderscope/db';
import { escapeHtml, fmtUsdCompact, shortAddr } from '@insiderscope/shared';

const MILESTONES = [2, 5, 10, 25, 50, 100];

/**
 * Feed a fresh market cap into an open auto-buy position: `last` always moves,
 * `peak` only ratchets up, and when the peak crosses a new milestone multiple
 * (2x/5x/10x/...) a Turkish notification text is returned exactly once per
 * level. Called from the live event pipeline (minutes-level resolution while
 * the token trades) and the hourly ATH refresh (coverage when it goes quiet).
 */
export async function updatePaperMc(
  db: Db,
  mint: string,
  mcUsd: number,
): Promise<string | null> {
  if (!Number.isFinite(mcUsd) || mcUsd <= 0) return null;
  const rows = await db
    .update(paperTrades)
    .set({
      lastMcUsd: mcUsd,
      lastCheckTs: sql`now()`,
      peakTs: sql`case when ${mcUsd} > coalesce(${paperTrades.peakMcUsd}, 0) then now() else ${paperTrades.peakTs} end`,
      peakMcUsd: sql`greatest(coalesce(${paperTrades.peakMcUsd}, 0), ${mcUsd})`,
    })
    .where(and(eq(paperTrades.mint, mint), eq(paperTrades.status, 'open')))
    .returning({
      id: paperTrades.id,
      entryMcUsd: paperTrades.entryMcUsd,
      peakMcUsd: paperTrades.peakMcUsd,
      milestoneNotified: paperTrades.milestoneNotified,
      isLive: paperTrades.isLive,
      solSpent: paperTrades.solSpent,
    });
  const row = rows[0];
  if (!row || row.entryMcUsd == null || row.entryMcUsd <= 0 || row.peakMcUsd == null) return null;

  const multiple = row.peakMcUsd / row.entryMcUsd;
  const reached = MILESTONES.filter((m) => multiple >= m && m > row.milestoneNotified).pop();
  if (reached == null) return null;

  await db.update(paperTrades).set({ milestoneNotified: reached }).where(eq(paperTrades.id, row.id));
  const symbolRows = await db
    .select({ symbol: tokens.symbol })
    .from(tokens)
    .where(eq(tokens.mint, mint))
    .limit(1);
  const name = symbolRows[0]?.symbol ? `$${escapeHtml(symbolRows[0].symbol)}` : shortAddr(mint);
  const mode = row.isLive ? 'GERÇEK ALIM' : 'DRY-RUN alımı';
  const wouldBe = row.solSpent * multiple;
  return [
    `🚀 <b>${mode} ${reached}X OLDU</b> — ${name}`,
    `Giriş ${fmtUsdCompact(row.entryMcUsd)} → tepe ${fmtUsdCompact(row.peakMcUsd)} (şu an ${multiple.toFixed(1)}x)`,
    `${row.solSpent} SOL ${row.isLive ? '' : 'simüle '}giriş şu an ~${wouldBe.toFixed(2)} SOL ederdi`,
    `<a href="https://gmgn.ai/sol/token/${mint}">GMGN</a> | <a href="https://dexscreener.com/solana/${mint}">DexScreener</a>`,
  ].join('\n');
}

/** Mints with an open position — the hourly refresh keeps their MC current. */
export async function openPaperMints(db: Db): Promise<string[]> {
  const rows = await db
    .select({ mint: paperTrades.mint })
    .from(paperTrades)
    .where(eq(paperTrades.status, 'open'));
  return rows.map((r) => r.mint);
}

/** Positions older than `days` stop tracking — the final peak is the verdict. */
export async function closeStalePaperTrades(db: Db, days = 14): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .update(paperTrades)
    .set({ status: 'closed' })
    .where(and(eq(paperTrades.status, 'open'), lt(paperTrades.entryTs, cutoff)))
    .returning({ id: paperTrades.id });
  return rows.length;
}

export interface PaperStats {
  openCount: number;
  totalCount: number;
  spentTodaySol: number;
  avgX: number | null;
  maxX: number | null;
  best: { mint: string; symbol: string | null; x: number; entryMcUsd: number | null; isLive: boolean }[];
}

/** Aggregates for /autobuy status, the daily digest and the health report. */
export async function paperStats(db: Db): Promise<PaperStats> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const xExpr = sql<number>`(${paperTrades.peakMcUsd} / nullif(${paperTrades.entryMcUsd}, 0))::float8`;
  const agg = await db
    .select({
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${paperTrades.status} = 'open')::int`,
      spentToday: sql<number>`coalesce(sum(${paperTrades.solSpent}) filter (where ${paperTrades.entryTs} >= ${startOfDay.toISOString()}::timestamptz), 0)::float8`,
      avgX: sql<number | null>`avg(${paperTrades.peakMcUsd} / nullif(${paperTrades.entryMcUsd}, 0))::float8`,
      maxX: sql<number | null>`max(${paperTrades.peakMcUsd} / nullif(${paperTrades.entryMcUsd}, 0))::float8`,
    })
    .from(paperTrades);

  const best = await db
    .select({
      mint: paperTrades.mint,
      symbol: tokens.symbol,
      x: xExpr,
      entryMcUsd: paperTrades.entryMcUsd,
      isLive: paperTrades.isLive,
    })
    .from(paperTrades)
    .leftJoin(tokens, eq(paperTrades.mint, tokens.mint))
    .where(and(gte(paperTrades.entryMcUsd, 0), sql`${paperTrades.peakMcUsd} is not null`))
    .orderBy(desc(xExpr))
    .limit(3);

  const a = agg[0];
  return {
    openCount: a?.open ?? 0,
    totalCount: a?.total ?? 0,
    spentTodaySol: a?.spentToday ?? 0,
    avgX: a?.avgX ?? null,
    maxX: a?.maxX ?? null,
    best: best.filter((b) => b.x != null) as PaperStats['best'],
  };
}
