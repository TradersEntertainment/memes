import { and, count, eq, gte, isNotNull, liveEvents, sql, tokens, wallets } from '@insiderscope/db';
import { escapeHtml, shortAddr } from '@insiderscope/shared';
import type { AppCtx } from '../context';

const EVENT_TR: Record<string, string> = {
  buy: 'alım',
  sell: 'satış',
  transfer_out: 'rotasyon',
  transfer_in: 'gelen transfer',
};

/** 09:00 UTC every day: what happened in the last 24h, in one message. */
export async function sendDailyDigest(ctx: AppCtx): Promise<void> {
  if (!ctx.cfg.DIGEST_ENABLED) return;
  const { db } = ctx;
  const dayAgo = new Date(Date.now() - 24 * 3600_000);

  const eventRows = await db
    .select({ type: liveEvents.eventType, n: count() })
    .from(liveEvents)
    .where(gte(liveEvents.ts, dayAgo))
    .groupBy(liveEvents.eventType);

  const topTokens = await db
    .select({
      mint: liveEvents.mint,
      symbol: tokens.symbol,
      buyers: count(),
    })
    .from(liveEvents)
    .leftJoin(tokens, eq(liveEvents.mint, tokens.mint))
    .where(and(eq(liveEvents.eventType, 'buy'), gte(liveEvents.ts, dayAgo), isNotNull(liveEvents.mint)))
    .groupBy(liveEvents.mint, tokens.symbol)
    .orderBy(sql`count(*) desc`)
    .limit(3);

  const tierRows = await db
    .select({ tier: wallets.tier, n: count() })
    .from(wallets)
    .where(eq(wallets.isActive, true))
    .groupBy(wallets.tier);
  const tiers = Object.fromEntries(tierRows.map((r) => [r.tier ?? 'aday', r.n]));

  const eventLine =
    eventRows.length > 0
      ? eventRows.map((r) => `${r.n} ${EVENT_TR[r.type] ?? r.type}`).join(' · ')
      : 'olay yok (izlenen cüzdanlar sessizdi)';
  const tokenLine =
    topTokens.length > 0
      ? topTokens
          .sort((a, b) => b.buyers - a.buyers)
          .map((t) => `${t.symbol ? `$${escapeHtml(t.symbol)}` : shortAddr(t.mint!)} (${t.buyers})`)
          .join(', ')
      : '—';

  const text = [
    `📊 <b>Günlük özet</b> (son 24 saat)`,
    `Olaylar: ${eventLine}`,
    `En çok alınan: ${tokenLine}`,
    `İzleme: ⭐ ${tiers.insider ?? 0} insider · 👀 ${tiers.watch ?? 0} watch · 🕒 ${tiers.probation ?? 0} probation`,
  ].join('\n');
  await ctx.alertsQueue.add('custom', { custom: { text } });
}
