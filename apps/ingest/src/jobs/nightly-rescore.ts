import {
  buildCtx as buildAnalyzerCtx,
  runDiscover,
  runEarlyBuyersAll,
  runFundingAll,
  runImportDir,
  runScoreAll,
} from '@insiderscope/analyzer';
import type { AppCtx } from '../context';
import { invalidateWatchedCache } from '../watched';
import { syncHeliusWebhook } from './../webhook-sync';

/**
 * The full historical pipeline, unattended (Phase 4.2). Runs nightly at 03:00 UTC
 * and on demand via the bot's /scan command, so nobody has to hold an SSH session
 * open: pick up CSVs dropped in TOKENS_DIR → discover new $10M candidates → crawl
 * their early buyers → build the funding graph → rescore every wallet → push the
 * refreshed watch list to Helius.
 *
 * Each stage is isolated: a failing stage logs and the rest still run, because a
 * half-finished pipeline is far better than none (every command is idempotent and
 * resumes cleanly on the next pass).
 */
export async function nightlyRescore(ctx: AppCtx): Promise<void> {
  const started = Date.now();
  ctx.log('pipeline: starting (discover → early-buyers → funding → score)');
  const analyzerCtx = buildAnalyzerCtx();

  const stages: [string, () => Promise<unknown>][] = [
    ['import-dir', () => runImportDir(analyzerCtx)],
    ['discover', () => runDiscover(analyzerCtx)],
    ['early-buyers', () => runEarlyBuyersAll(analyzerCtx)],
    ['funding', () => runFundingAll(analyzerCtx)],
    ['score', () => runScoreAll(analyzerCtx)],
  ];
  for (const [name, run] of stages) {
    try {
      await run();
    } catch (err) {
      ctx.log(`pipeline: ${name} failed — ${err instanceof Error ? err.message : err}`);
    }
  }

  invalidateWatchedCache();
  await syncHeliusWebhook(ctx).catch((err) => ctx.log(`pipeline: webhook sync failed: ${err}`));
  ctx.log(`pipeline: done in ${Math.round((Date.now() - started) / 1000)}s`);
}
