import {
  buildCtx as buildAnalyzerCtx,
  runDiscover,
  runEarlyBuyersAll,
  runFundingAll,
  runImportDir,
  runScoreAll,
} from '@insiderscope/analyzer';
import { count, eq, sql, tokens, wallets } from '@insiderscope/db';
import { HeliusCircuitOpenError } from '@insiderscope/shared';
import type { AppCtx } from '../context';
import { invalidateWatchedCache } from '../watched';
import { syncHeliusWebhook } from './../webhook-sync';

export type PipelineReason = 'boot' | 'nightly' | 'manual' | 'tokens-added';

const REASON_TR: Record<PipelineReason, string> = {
  boot: 'sunucu açılışı',
  nightly: 'gece planı (03:00 UTC)',
  manual: '/scan komutu',
  'tokens-added': 'yeni token eklendi',
};

/** Telegram + log in one place; the pipeline must never die on a notify failure. */
async function notify(ctx: AppCtx, html: string): Promise<void> {
  ctx.log(html.replace(/<[^>]+>/g, ''));
  if (ctx.bot && ctx.cfg.TELEGRAM_CHAT_ID) {
    await ctx.bot.api
      .sendMessage(ctx.cfg.TELEGRAM_CHAT_ID, html, { parse_mode: 'HTML' })
      .catch((err) => ctx.log(`notify failed: ${err}`));
  }
}

async function candidateCount(ctx: AppCtx): Promise<number> {
  const rows = await ctx.db
    .select({ n: count() })
    .from(tokens)
    .where(eq(tokens.status, 'candidate'));
  return rows[0]?.n ?? 0;
}

async function summaryLines(ctx: AppCtx): Promise<string[]> {
  const tokenRows = await ctx.db
    .select({ status: tokens.status, n: count() })
    .from(tokens)
    .groupBy(tokens.status);
  const tierRows = await ctx.db
    .select({ tier: wallets.tier, n: count() })
    .from(wallets)
    .where(eq(wallets.isActive, true))
    .groupBy(wallets.tier);
  const t = Object.fromEntries(tokenRows.map((r) => [r.status, r.n]));
  const w = Object.fromEntries(tierRows.map((r) => [r.tier ?? 'aday', r.n]));
  return [
    `Tokenlar: ${t.analyzed ?? 0} analiz / ${t.skipped ?? 0} atlandı / ${t.candidate ?? 0} sırada`,
    `Cüzdanlar: ⭐ ${w.insider ?? 0} insider · 👀 ${w.watch ?? 0} watch · 🕒 ${w.probation ?? 0} probation`,
  ];
}

/**
 * The full historical pipeline, unattended (Phase 4.2): import curated CSVs →
 * discover → early-buyers → funding → score → refresh the Helius webhook.
 * Triggered by boot (when there's pending work), the nightly cron, /scan, and
 * /tokens. Start/finish/abort are reported to Telegram.
 *
 * Stages are isolated — one failing stage logs and the rest still run — with one
 * exception: an open Helius circuit (credits/rate limit exhausted) aborts the
 * remaining stages, because every call would fail anyway. Everything is
 * idempotent, so the next pass resumes exactly where this one stopped.
 */
export async function nightlyRescore(ctx: AppCtx, reason: PipelineReason = 'nightly'): Promise<void> {
  const started = Date.now();
  const analyzerCtx = buildAnalyzerCtx();

  await runImportDir(analyzerCtx).catch((err) => ctx.log(`pipeline: import-dir failed — ${err}`));
  const pending = await candidateCount(ctx);
  await notify(
    ctx,
    `🔄 <b>Analiz turu başladı</b> — ${REASON_TR[reason]}\nSırada ${pending} aday token var; cüzdan skorları da tazelenecek.`,
  );

  const stages: [string, () => Promise<unknown>][] = [
    ['discover', () => runDiscover(analyzerCtx)],
    ['early-buyers', () => runEarlyBuyersAll(analyzerCtx)],
    ['funding', () => runFundingAll(analyzerCtx)],
    ['score', () => runScoreAll(analyzerCtx)],
  ];
  const stageErrors: string[] = [];
  let aborted: HeliusCircuitOpenError | null = null;

  for (const [name, run] of stages) {
    try {
      await run();
    } catch (err) {
      if (err instanceof HeliusCircuitOpenError) {
        aborted = err;
        break;
      }
      const msg = err instanceof Error ? err.message : String(err);
      stageErrors.push(`${name}: ${msg.slice(0, 160)}`);
      ctx.log(`pipeline: ${name} failed — ${msg}`);
    }
  }

  invalidateWatchedCache();
  await syncHeliusWebhook(ctx).catch((err) => ctx.log(`pipeline: webhook sync failed: ${err}`));

  const minutes = Math.max(1, Math.round((Date.now() - started) / 60_000));
  const lines = await summaryLines(ctx).catch(() => []);

  if (aborted) {
    const resumeAt = new Date(aborted.untilTs).toISOString().slice(11, 16);
    await notify(
      ctx,
      [
        `⛔ <b>Tur durduruldu — Helius erişimi kesildi</b> (${minutes} dk çalıştı)`,
        `Sebep: ${aborted.reason}`,
        `Kalan iş kayıtlı; canlı takip sürüyor. Devre ~${resumeAt} UTC'de tekrar denenir, kalan analiz gece turunda kaldığı yerden devam eder.`,
        `Kredi durumu: dashboard.helius.dev`,
        ...lines,
      ].join('\n'),
    );
    return;
  }

  await notify(
    ctx,
    [
      `✅ <b>Analiz turu bitti</b> (${minutes} dk — ${REASON_TR[reason]})`,
      ...lines,
      ...(stageErrors.length > 0 ? [`⚠️ Hatalı aşamalar: ${stageErrors.join(' | ')}`] : []),
      `Sonraki otomatik tur: her gece 03:00 UTC. /list ile listeye bakabilirsin.`,
    ].join('\n'),
  );
}

/**
 * Decide on its own whether a pass is needed and queue exactly one. Used at boot
 * and after /tokens: refresh the candidate pool from TOKENS_DIR/seed, then only
 * enqueue when there is actual pending work and no pass is already queued or
 * running — so redeploys never stampede the API.
 */
export async function maybeAutoScan(ctx: AppCtx, reason: PipelineReason): Promise<boolean> {
  const counts = await ctx.pipelineQueue.getJobCounts('active', 'waiting', 'delayed');
  if ((counts.active ?? 0) + (counts.waiting ?? 0) + (counts.delayed ?? 0) > 0) {
    ctx.log(`auto-scan (${reason}): a pass is already queued/running — skipped`);
    return false;
  }

  await runImportDir(buildAnalyzerCtx()).catch((err) =>
    ctx.log(`auto-scan: import-dir failed — ${err}`),
  );
  const pending = await candidateCount(ctx);
  const neverScored = await ctx.db
    .select({ n: count() })
    .from(wallets)
    .where(sql`${wallets.insiderScore} is null and ${wallets.tier} is null`);
  if (pending === 0 && (neverScored[0]?.n ?? 0) === 0) {
    ctx.log(`auto-scan (${reason}): no pending work — skipped`);
    return false;
  }

  await ctx.pipelineQueue.add('pipeline', { reason });
  ctx.log(`auto-scan (${reason}): queued a pass (${pending} candidate token(s))`);
  return true;
}
