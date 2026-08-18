import { and, eq, gte, inArray, isNotNull, liveEvents, tokens, wallets, type Db } from '@insiderscope/db';
import { escapeHtml, shortAddr, type AppConfig } from '@insiderscope/shared';

/**
 * Confluence detection: one insider buying is a signal, several watched wallets
 * buying the SAME mint inside a short window is the strongest signal this system
 * produces. The data was already in live_events — this turns it into a combined
 * alert (once per mint per window, deduped via the caller's redis flag).
 */
export async function buildConfluenceAlert(
  db: Db,
  cfg: AppConfig,
  mint: string,
): Promise<{ text: string; buyers: number } | null> {
  const windowStart = new Date(Date.now() - cfg.CONFLUENCE_WINDOW_MIN * 60_000);
  const rows = await db
    .selectDistinct({
      wallet: liveEvents.wallet,
      label: wallets.label,
      tier: wallets.tier,
      score: wallets.insiderScore,
    })
    .from(liveEvents)
    .innerJoin(wallets, eq(liveEvents.wallet, wallets.address))
    .where(
      and(
        eq(liveEvents.mint, mint),
        eq(liveEvents.eventType, 'buy'),
        gte(liveEvents.ts, windowStart),
        inArray(wallets.tier, ['insider', 'watch']),
        isNotNull(wallets.tier),
      ),
    );
  if (rows.length < cfg.CONFLUENCE_MIN_WALLETS) return null;

  const token = (await db.select().from(tokens).where(eq(tokens.mint, mint)).limit(1))[0];
  const name = token?.symbol ? `$${escapeHtml(token.symbol)}` : shortAddr(mint);
  const who = rows
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 6)
    .map(
      (r) =>
        `${r.tier === 'insider' ? '⭐' : '👀'} ${r.label ? escapeHtml(r.label) : shortAddr(r.wallet)}${
          r.score != null ? ` (${Math.round(r.score)})` : ''
        }`,
    )
    .join('\n');

  const text = [
    `🔥 <b>CONFLUENCE — ${rows.length} izlenen cüzdan aynı tokena girdi</b>`,
    `Token: ${name} (son ${cfg.CONFLUENCE_WINDOW_MIN} dk)`,
    who,
    `Linkler: <a href="https://dexscreener.com/solana/${mint}">DexScreener</a> | <a href="https://gmgn.ai/sol/token/${mint}">GMGN</a>`,
  ].join('\n');
  return { text, buyers: rows.length };
}
