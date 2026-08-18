import { buildCtx as buildAnalyzerCtx, runDiscover, runScoreAll } from '@insiderscope/analyzer';
import type { AppCtx } from '../context';
import { invalidateWatchedCache } from '../watched';
import { syncHeliusWebhook } from '../webhook-sync';

/**
 * Phase 4.2 — nightly (03:00 UTC): refresh ATHs / scan for new $10M tokens and
 * rescore every wallet, then push the (possibly changed) watched set to Helius.
 * Runs the analyzer in-process; both apps share the same env and database.
 */
export async function nightlyRescore(ctx: AppCtx): Promise<void> {
  ctx.log('nightly-rescore: starting');
  const analyzerCtx = buildAnalyzerCtx();
  await runDiscover(analyzerCtx).catch((err) => ctx.log(`nightly discover failed: ${err}`));
  await runScoreAll(analyzerCtx).catch((err) => ctx.log(`nightly score failed: ${err}`));
  invalidateWatchedCache();
  await syncHeliusWebhook(ctx).catch((err) => ctx.log(`nightly webhook sync failed: ${err}`));
  ctx.log('nightly-rescore: done');
}
