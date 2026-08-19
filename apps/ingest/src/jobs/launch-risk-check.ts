import { escapeHtml, shortAddr } from '@insiderscope/shared';
import type { AppCtx } from '../context';
import { assessLaunchRisk } from '../launch-risk';

export interface LaunchRiskJobData {
  mint: string;
  symbol: string | null;
}

/**
 * Runs ~5 minutes after a 🧨 dev-launch alert: by then a supply grab or a
 * painted market cap is visible. Risky findings produce ONE follow-up warning
 * (redis-deduped) so the launch alert never stands unqualified.
 */
export async function runLaunchRiskCheck(ctx: AppCtx, data: LaunchRiskJobData): Promise<void> {
  const risk = await assessLaunchRisk(
    {
      db: ctx.db,
      helius: ctx.helius,
      pumpCache: ctx.pumpCache,
      log: ctx.log,
      solPriceFallbackUsd: ctx.cfg.SOL_PRICE_FALLBACK_USD,
    },
    data.mint,
  );
  if (!risk.risky) {
    ctx.log(`launch-risk ${data.mint.slice(0, 6)}…: clean (top1 ${risk.top1Pct?.toFixed(1) ?? '?'}%)`);
    return;
  }
  if ((await ctx.redis.set(`is:riskcheck:${data.mint}`, '1', 'EX', 86_400, 'NX')) !== 'OK') return;

  const name = data.symbol ? `$${escapeHtml(data.symbol)}` : shortAddr(data.mint);
  const text = [
    `⚠️ <b>TUZAK İŞARETLERİ</b> — ${name} (${shortAddr(data.mint)})`,
    ...risk.flags.map((f) => `• ${f}`),
    `Bu launch'a girilmemesi önerilir — büyük ihtimalle exit-liquidity kurgusu.`,
  ].join('\n');
  await ctx.alertsQueue.add('custom', { custom: { text } });
}
