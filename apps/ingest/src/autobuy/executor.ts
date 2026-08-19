import { and, eq, gte, paperTrades, sql, type Db } from '@insiderscope/db';
import {
  escapeHtml,
  fmtUsdCompact,
  HeliusClient,
  PUMPPORTAL_TRADE_LOCAL_URL,
  shortAddr,
  type AppConfig,
} from '@insiderscope/shared';
import { ensureTokenMeta } from '../pipeline/enrich';
import { assessLaunchRisk } from '../launch-risk';
import type { PumpCurveCache } from '../pump-cache';
import type { WatchedWallet } from '../watched';
import { fmtSol } from '../alerts/format';

export interface AutoBuyDeps {
  db: Db;
  cfg: AppConfig;
  log: (msg: string) => void;
  pumpCache: PumpCurveCache | null;
  helius: HeliusClient | null;
  /** Telegram kill switch state (redis `is:autobuy:paused`). */
  isPaused: () => Promise<boolean>;
  notify: (text: string) => Promise<void>;
  trackMint?: (mint: string) => void;
  /** Test hook for the trade-local call. */
  fetchImpl?: typeof fetch;
}

export interface AutoBuySignal {
  wallet: Pick<WatchedWallet, 'address' | 'tier' | 'label' | 'insiderScore'>;
  mint: string;
  mcUsd: number | null;
  ts: Date;
}

export type AutoBuyOutcome = 'dry' | 'live' | 'skipped';

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * The auto-buy gate. Every filter also runs in dry-run so the paper record
 * previews live behavior exactly: tier → kill switch → event freshness (a
 * reconciliation backfill must never buy old history) → fresh-mint test
 * (young launch OR small cap) → one-position-per-mint (the table's unique) →
 * daily SOL ceiling (real and simulated spend count the same).
 */
export async function maybeAutoBuy(deps: AutoBuyDeps, signal: AutoBuySignal): Promise<AutoBuyOutcome> {
  const { db, cfg, log } = deps;
  const tag = `autobuy ${shortAddr(signal.mint)}`;
  if (!cfg.AUTOBUY_ENABLED) return 'skipped';

  const tiers = cfg.AUTOBUY_TIERS.split(',').map((s) => s.trim()).filter(Boolean);
  if (!signal.wallet.tier || !tiers.includes(signal.wallet.tier)) return 'skipped';

  if (await deps.isPaused()) {
    log(`${tag}: skipped — paused via /autobuy off`);
    return 'skipped';
  }

  const eventAgeMin = (Date.now() - signal.ts.getTime()) / 60_000;
  if (eventAgeMin > cfg.ALERT_MAX_AGE_MIN) return 'skipped'; // backfill, not live flow

  const meta = await ensureTokenMeta({ db, pumpCache: deps.pumpCache }, signal.mint);
  const ageSec = meta.launchTs ? (signal.ts.getTime() - meta.launchTs.getTime()) / 1000 : null;
  const fresh =
    (ageSec != null && ageSec >= 0 && ageSec <= cfg.AUTOBUY_MAX_MINT_AGE_MIN * 60) ||
    (signal.mcUsd != null && signal.mcUsd <= cfg.AUTOBUY_MAX_MC_USD);
  if (!fresh) {
    log(`${tag}: skipped — not a fresh mint (age ${ageSec == null ? '?' : Math.round(ageSec)}s, mc ${signal.mcUsd ?? '?'})`);
    return 'skipped';
  }

  // Bait guard: one wallet sitting on a huge share of supply is exit
  // liquidity waiting for us — not a trade. Runs in dry-run too, so the paper
  // record shows the traps that were dodged. (0 disables.)
  if (cfg.AUTOBUY_MAX_TOP_HOLDER_PCT > 0 && deps.helius) {
    const risk = await assessLaunchRisk(
      {
        db,
        helius: deps.helius,
        pumpCache: deps.pumpCache,
        log,
        solPriceFallbackUsd: cfg.SOL_PRICE_FALLBACK_USD,
      },
      signal.mint,
    ).catch(() => null);
    if (risk?.top1Pct != null && risk.top1Pct > cfg.AUTOBUY_MAX_TOP_HOLDER_PCT) {
      log(`${tag}: skipped — top holder owns ${risk.top1Pct.toFixed(1)}% of supply (bait guard)`);
      return 'skipped';
    }
  }

  const spentRows = await db
    .select({ s: sql<number>`coalesce(sum(${paperTrades.solSpent}), 0)::float8` })
    .from(paperTrades)
    .where(gte(paperTrades.entryTs, startOfUtcDay()));
  const spentToday = spentRows[0]?.s ?? 0;
  if (spentToday + cfg.AUTOBUY_SOL_PER_TRADE > cfg.AUTOBUY_DAILY_CAP_SOL) {
    log(`${tag}: skipped — daily cap (${spentToday}/${cfg.AUTOBUY_DAILY_CAP_SOL} SOL)`);
    return 'skipped';
  }

  const now = new Date();
  const inserted = await db
    .insert(paperTrades)
    .values({
      mint: signal.mint,
      wallet: signal.wallet.address,
      solSpent: cfg.AUTOBUY_SOL_PER_TRADE,
      entryMcUsd: signal.mcUsd,
      peakMcUsd: signal.mcUsd,
      peakTs: signal.mcUsd != null ? now : null,
      troughMcUsd: signal.mcUsd,
      troughTs: signal.mcUsd != null ? now : null,
      lastMcUsd: signal.mcUsd,
      lastCheckTs: now,
    })
    .onConflictDoNothing()
    .returning({ id: paperTrades.id });
  const row = inserted[0];
  if (!row) return 'skipped'; // already holding this mint

  deps.trackMint?.(signal.mint);

  let who = signal.wallet.label
    ? `${escapeHtml(signal.wallet.label)} (${shortAddr(signal.wallet.address)})`
    : shortAddr(signal.wallet.address);
  if (cfg.WEB_BASE_URL) {
    who = `<a href="${cfg.WEB_BASE_URL}/insiders/${signal.wallet.address}">${who}</a>`;
  }
  const scorePart = signal.wallet.insiderScore != null ? `, skor ${Math.round(signal.wallet.insiderScore)}` : '';
  const detail = [
    `Sinyal: ${who} (${signal.wallet.tier}${scorePart}) taze token aldı`,
    `Token: ${meta.symbol ? `$${escapeHtml(meta.symbol)} ` : ''}(${shortAddr(signal.mint)})`,
    `Giriş MC: ${fmtUsdCompact(signal.mcUsd)}${ageSec != null ? ` | Launch +${Math.round(ageSec / 60)}dk` : ''}`,
    `Linkler: <a href="https://gmgn.ai/sol/token/${signal.mint}">GMGN</a> | <a href="https://jup.ag/swap/SOL-${signal.mint}">Jupiter</a> | <a href="https://dexscreener.com/solana/${signal.mint}">DexScreener</a>`,
  ];

  const liveReady = !cfg.AUTOBUY_DRY_RUN && cfg.AUTOBUY_WALLET_SECRET && deps.helius;
  if (!liveReady) {
    await deps.notify(
      [
        `🧪 <b>DRY-RUN ALIM</b> — ${fmtSol(cfg.AUTOBUY_SOL_PER_TRADE)} SOL (simülasyon)`,
        ...detail,
        `Takipteyim: kaç X yaptığını bildireceğim. Bugün: ${fmtSol(spentToday + cfg.AUTOBUY_SOL_PER_TRADE)}/${fmtSol(cfg.AUTOBUY_DAILY_CAP_SOL)} SOL`,
      ].join('\n'),
    );
    return 'dry';
  }

  try {
    const txSignature = await executeLiveBuy(deps, signal.mint);
    await db
      .update(paperTrades)
      .set({ isLive: true, txSignature })
      .where(eq(paperTrades.id, row.id));
    await deps.notify(
      [
        `🤖 <b>GERÇEK ALIM YAPILDI</b> — ${fmtSol(cfg.AUTOBUY_SOL_PER_TRADE)} SOL`,
        ...detail,
        `Tx: <a href="https://solscan.io/tx/${txSignature}">Solscan</a>`,
      ].join('\n'),
    );
    return 'live';
  } catch (err) {
    // Failed live buy: drop the position so the mint can be retried on the
    // insider's next signal, and say what happened.
    await db.delete(paperTrades).where(and(eq(paperTrades.id, row.id), eq(paperTrades.isLive, false)));
    const msg = err instanceof Error ? err.message : String(err);
    log(`${tag}: live buy failed — ${msg}`);
    await deps.notify(
      `⚠️ <b>Oto-alım BAŞARISIZ</b> — ${shortAddr(signal.mint)}\nSebep: ${escapeHtml(msg.slice(0, 200))}\nPozisyon açılmadı; sinyal gelirse tekrar denenir.`,
    );
    return 'skipped';
  }
}

/** PumpPortal trade-local → sign locally → send through Helius RPC. */
async function executeLiveBuy(deps: AutoBuyDeps, mint: string): Promise<string> {
  const { cfg } = deps;
  if (!deps.helius) throw new Error('Helius client unavailable');
  const [{ Keypair, VersionedTransaction }, bs58] = await Promise.all([
    import('@solana/web3.js'),
    import('bs58').then((m) => m.default),
  ]);
  const keypair = Keypair.fromSecretKey(bs58.decode(cfg.AUTOBUY_WALLET_SECRET));

  const res = await (deps.fetchImpl ?? fetch)(PUMPPORTAL_TRADE_LOCAL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publicKey: keypair.publicKey.toBase58(),
      action: 'buy',
      mint,
      amount: cfg.AUTOBUY_SOL_PER_TRADE,
      denominatedInSol: 'true',
      slippage: cfg.AUTOBUY_SLIPPAGE_PCT,
      priorityFee: cfg.AUTOBUY_PRIORITY_FEE_SOL,
      pool: 'auto',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`trade-local HTTP ${res.status}`);

  const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  tx.sign([keypair]);
  const encoded = Buffer.from(tx.serialize()).toString('base64');
  const signature = await deps.helius.rpc<string>('sendTransaction', [
    encoded,
    { encoding: 'base64', skipPreflight: true, maxRetries: 3 },
  ]);
  if (typeof signature !== 'string') throw new Error('sendTransaction returned no signature');
  return signature;
}
