import {
  and,
  desc,
  eq,
  inArray,
  positions,
  sql,
  tokens,
  wallets,
} from '@insiderscope/db';
import {
  escapeHtml,
  fmtUsdCompact,
  isValidSolanaAddress,
  shortAddr,
} from '@insiderscope/shared';
import type { Bot, CommandContext, Context } from 'grammy';
import type { AppCtx } from '../context';
import { maybeAutoScan } from '../jobs/nightly-rescore';
import { invalidateWatchedCache } from '../watched';
import { syncHeliusWebhook } from '../webhook-sync';

const HELP = [
  '<b>InsiderScope bot</b>',
  '/list — aktif insider/watch listesi',
  '/add &lt;adres&gt; [etiket] — cüzdanı izlemeye al (watch)',
  '/mute &lt;adres&gt; — alertleri sustur',
  '/unmute &lt;adres&gt; — alertleri aç',
  '/stats &lt;adres&gt; — cüzdan özeti',
  '/scan — tam analiz turunu şimdi başlat (gece 03:00 UTC otomatik çalışır)',
  '/tokens &lt;mint&gt;[,&lt;mint&gt;…] — aday token ekle, sonraki turda taranır',
].join('\n');

const tierEmoji: Record<string, string> = {
  insider: '⭐',
  watch: '👀',
  probation: '🕒',
  blacklist: '⛔',
};

export function registerCommands(bot: Bot, ctx: AppCtx): void {
  const { db } = ctx;

  bot.command(['start', 'help'], (c) => c.reply(HELP, { parse_mode: 'HTML' }));

  bot.command('list', async (c) => {
    const rows = await db
      .select()
      .from(wallets)
      .where(and(eq(wallets.isActive, true), inArray(wallets.tier, ['insider', 'watch'])))
      .orderBy(desc(wallets.insiderScore))
      .limit(30);
    if (rows.length === 0) {
      await c.reply('Aktif izlenen cüzdan yok. /add ile ekleyebilirsin.');
      return;
    }
    const lines = rows.map((w) => {
      const name = w.label ? `${escapeHtml(w.label)} ` : '';
      const score = w.insiderScore != null ? `skor ${Math.round(w.insiderScore)}` : 'skorsuz';
      const wr = w.winRate != null ? `, WR %${Math.round(w.winRate * 100)}` : '';
      const muted = w.muted ? ' 🔇' : '';
      return `${tierEmoji[w.tier ?? ''] ?? '•'} ${name}<code>${shortAddr(w.address)}</code> — ${score}${wr}${muted}`;
    });
    await c.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.command('add', async (c) => {
    const parts = (c.match ?? '').trim().split(/\s+/).filter(Boolean);
    const address = parts[0];
    const label = parts.slice(1).join(' ') || null;
    if (!address || !isValidSolanaAddress(address)) {
      await c.reply('Kullanım: /add <adres> [etiket]');
      return;
    }
    // seed last_sig so reconciliation doesn't replay the wallet's entire past
    let lastSig: string | null = null;
    if (ctx.helius) {
      const recent = await ctx.helius.getParsedTransactions(address, { limit: 1 }).catch(() => []);
      lastSig = recent[0]?.signature ?? null;
    }
    await db
      .insert(wallets)
      .values({
        address,
        label,
        tier: 'watch',
        isActive: true,
        firstSeen: new Date(),
        lastSig,
      })
      .onConflictDoUpdate({
        target: wallets.address,
        set: {
          isActive: true,
          ...(label ? { label } : {}),
          // manual add never downgrades an existing tier, only fills a blank
          tier: sql`coalesce(${wallets.tier}, 'watch')`,
        },
      });
    invalidateWatchedCache();
    void syncHeliusWebhook(ctx).catch((err) => ctx.log(`webhook sync after /add failed: ${err}`));
    await c.reply(`✅ İzlemeye alındı: <code>${shortAddr(address)}</code> (watch)`, {
      parse_mode: 'HTML',
    });
  });

  const setMuted = (muted: boolean) => async (c: CommandContext<Context>) => {
    const address = (c.match ?? '').trim();
    if (!address || !isValidSolanaAddress(address)) {
      await c.reply(`Kullanım: /${muted ? 'mute' : 'unmute'} <adres>`);
      return;
    }
    const updated = await db
      .update(wallets)
      .set({ muted })
      .where(eq(wallets.address, address))
      .returning({ address: wallets.address });
    invalidateWatchedCache();
    await c.reply(
      updated.length > 0
        ? `${muted ? '🔇 Susturuldu' : '🔔 Açıldı'}: <code>${shortAddr(address)}</code>`
        : 'Cüzdan bulunamadı.',
      { parse_mode: 'HTML' },
    );
  };
  bot.command('mute', setMuted(true));
  bot.command('unmute', setMuted(false));

  bot.command('scan', async (c) => {
    const counts = await ctx.pipelineQueue.getJobCounts('active', 'waiting', 'delayed');
    if ((counts.active ?? 0) + (counts.waiting ?? 0) + (counts.delayed ?? 0) > 0) {
      await c.reply('⏳ Bir analiz turu zaten çalışıyor/kuyrukta — bittiğinde haber vereceğim.');
      return;
    }
    await ctx.pipelineQueue.add('pipeline', { reason: 'manual' });
    await c.reply('🔍 Analiz turu kuyruğa alındı — başlarken ve biterken buradan bildireceğim.');
  });

  bot.command('tokens', async (c) => {
    const mints = (c.match ?? '')
      .split(/[\s,]+/)
      .map((m) => m.trim())
      .filter(Boolean);
    const valid = mints.filter((m) => isValidSolanaAddress(m));
    if (valid.length === 0) {
      await c.reply('Kullanım: /tokens <mint> [<mint> …]');
      return;
    }
    await db
      .insert(tokens)
      .values(valid.map((mint) => ({ mint, status: 'candidate' as const })))
      .onConflictDoNothing();
    const queued = await maybeAutoScan(ctx, 'tokens-added').catch(() => false);
    await c.reply(
      `✅ ${valid.length} token aday olarak eklendi${mints.length > valid.length ? ` (${mints.length - valid.length} geçersiz atlandı)` : ''}. ${
        queued ? 'Tarama otomatik başlatıldı.' : 'Sıradaki turda taranacak.'
      }`,
    );
  });

  bot.command('stats', async (c) => {
    const address = (c.match ?? '').trim();
    if (!address || !isValidSolanaAddress(address)) {
      await c.reply('Kullanım: /stats <adres>');
      return;
    }
    const w = (await db.select().from(wallets).where(eq(wallets.address, address)).limit(1))[0];
    if (!w) {
      await c.reply('Cüzdan bulunamadı.');
      return;
    }
    const pos = await db
      .select({
        mint: positions.mint,
        symbol: tokens.symbol,
        pnl: positions.realizedPnlUsd,
        entryMc: positions.entryMcUsd,
        holding: positions.stillHolding,
      })
      .from(positions)
      .leftJoin(tokens, eq(positions.mint, tokens.mint))
      .where(eq(positions.wallet, address))
      .orderBy(desc(positions.firstBuyTs))
      .limit(5);

    const b = w.scoreBreakdown;
    const lines = [
      `📊 <code>${w.address}</code>${w.label ? ` — ${escapeHtml(w.label)}` : ''}`,
      `Tier: ${w.tier ?? 'aday'} | Skor: ${w.insiderScore != null ? Math.round(w.insiderScore) : '?'}${w.muted ? ' | 🔇' : ''}`,
      `WR: ${w.winRate != null ? `%${Math.round(w.winRate * 100)}` : '?'} | PnL: ${fmtUsdCompact(w.totalPnlUsd)} | Trade: ${w.totalTrades ?? '?'}`,
      `Ort. giriş MC: ${fmtUsdCompact(w.avgEntryMc)} | Kaynak: ${w.fundingSource ? escapeHtml(w.fundingSource.length > 20 ? shortAddr(w.fundingSource) : w.fundingSource) : '?'}`,
    ];
    if (b) {
      lines.push(
        `Breakdown: repeat ${b.points.repeat.toFixed(1)} | creator ${b.points.creatorLink.toFixed(1)} | wr ${b.points.winRate.toFixed(1)} | sel ${b.points.selectivity.toFixed(1)} | timing ${b.points.timing.toFixed(1)}`,
      );
    }
    if (pos.length > 0) {
      lines.push(
        'Son pozisyonlar: ' +
          pos
            .map(
              (p) =>
                `${p.symbol ? `$${escapeHtml(p.symbol)}` : shortAddr(p.mint)} ${
                  p.pnl != null ? fmtUsdCompact(p.pnl) : p.holding ? 'holding' : '?'
                }`,
            )
            .join(' | '),
      );
    }
    await c.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });
}
