import { alerts, eq, liveEvents, wallets, type Db } from '@insiderscope/db';
import type { AppConfig } from '@insiderscope/shared';
import type { Bot } from 'grammy';
import { ensureTokenMeta } from '../pipeline/enrich';
import type { PumpCurveCache } from '../pump-cache';
import { formatRotationAlert, formatSwapAlert, type AlertWalletInfo, type RotationAlertInput } from './format';

export interface SendCtx {
  db: Db;
  cfg: AppConfig;
  bot: Bot | null;
  pumpCache: PumpCurveCache | null;
  log: (msg: string) => void;
}

async function deliver(ctx: SendCtx, text: string, eventId: number | null): Promise<void> {
  let channel = 'log';
  if (ctx.bot && ctx.cfg.TELEGRAM_CHAT_ID) {
    await ctx.bot.api.sendMessage(ctx.cfg.TELEGRAM_CHAT_ID, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    channel = 'telegram';
  } else {
    ctx.log(`[alert:dry-run]\n${text.replace(/<[^>]+>/g, '')}`);
  }
  await ctx.db.insert(alerts).values({ eventId, channel, payload: { text } });
  if (eventId != null) {
    await ctx.db.update(liveEvents).set({ alerted: true }).where(eq(liveEvents.id, eventId));
  }
}

function walletInfo(w: {
  address: string;
  label: string | null;
  insiderScore: number | null;
  scoreBreakdown: { bigTokenCount: number } | null;
}): AlertWalletInfo {
  return {
    address: w.address,
    label: w.label,
    score: w.insiderScore,
    bigTokenCount: w.scoreBreakdown?.bigTokenCount ?? null,
  };
}

/** Alert-queue worker body: load the event, format Turkish, deliver, record. */
export async function sendSwapAlert(ctx: SendCtx, eventId: number): Promise<void> {
  const rows = await ctx.db
    .select({ event: liveEvents, wallet: wallets })
    .from(liveEvents)
    .innerJoin(wallets, eq(liveEvents.wallet, wallets.address))
    .where(eq(liveEvents.id, eventId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    ctx.log(`alert: event ${eventId} vanished`);
    return;
  }
  const { event, wallet } = row;
  if (event.alerted || !event.mint || (event.eventType !== 'buy' && event.eventType !== 'sell')) {
    return;
  }

  const meta = await ensureTokenMeta(ctx, event.mint);
  const secondsAfterLaunch = meta.launchTs
    ? (event.ts.getTime() - meta.launchTs.getTime()) / 1000
    : null;

  const text = formatSwapAlert({
    kind: event.eventType,
    wallet: walletInfo(wallet),
    mint: event.mint,
    tokenSymbol: meta.symbol,
    amountSol: event.amountSol ?? 0,
    mcUsd: event.mcAtEvent,
    secondsAfterLaunch,
    rotated:
      wallet.tier === 'probation' && wallet.parentWallet
        ? { parent: wallet.parentWallet }
        : null,
    signature: event.signature,
    freshMaxAgeSec: ctx.cfg.AUTOBUY_MAX_MINT_AGE_MIN * 60,
    freshMaxMcUsd: ctx.cfg.AUTOBUY_MAX_MC_USD,
  });
  await deliver(ctx, text, eventId);
}

export async function sendRotationAlert(
  ctx: SendCtx,
  input: RotationAlertInput & { eventId?: number | null },
): Promise<void> {
  await deliver(ctx, formatRotationAlert(input), input.eventId ?? null);
}

/** Pre-formatted composite alerts (confluence, dev-launch, digest). */
export async function sendCustomAlert(ctx: SendCtx, text: string): Promise<void> {
  await deliver(ctx, text, null);
}
