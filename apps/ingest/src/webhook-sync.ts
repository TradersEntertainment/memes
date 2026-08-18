import { createHash } from 'node:crypto';
import PQueue from 'p-queue';
import { and, eq, inArray, wallets, type Db } from '@insiderscope/db';
import type { AppConfig, HeliusClient } from '@insiderscope/shared';

export interface WebhookSyncCtx {
  db: Db;
  cfg: AppConfig;
  helius: HeliusClient | null;
  log: (msg: string) => void;
}

// Boot, /add, rotation-check and probation expiry can all trigger a sync at
// once; serialize them and skip no-op syncs via an address-set hash.
const syncQueue = new PQueue({ concurrency: 1 });
let lastHash: string | null = null;

/** Test hook. */
export function resetWebhookSyncState(): void {
  lastHash = null;
}

/** Register/refresh THE single Helius webhook with every active watched wallet. */
export async function syncHeliusWebhook(ctx: WebhookSyncCtx): Promise<void> {
  if (!ctx.helius || !ctx.cfg.PUBLIC_BASE_URL) {
    ctx.log('webhook-sync skipped (HELIUS_API_KEY or PUBLIC_BASE_URL missing)');
    return;
  }
  await syncQueue.add(async () => {
    const rows = await ctx.db
      .select({ address: wallets.address })
      .from(wallets)
      .where(
        and(eq(wallets.isActive, true), inArray(wallets.tier, ['insider', 'watch', 'probation'])),
      );
    const addresses = rows.map((r) => r.address).sort();
    const hash = createHash('sha256').update(addresses.join(',')).digest('hex');
    if (hash === lastHash) return;
    if (addresses.length === 0) {
      ctx.log('webhook-sync: no active watched wallets yet, nothing to register');
      return;
    }

    const webhookURL = `${ctx.cfg.PUBLIC_BASE_URL.replace(/\/+$/, '')}/webhook/helius`;
    const body = {
      webhookURL,
      transactionTypes: ['SWAP', 'TRANSFER'],
      accountAddresses: addresses,
      webhookType: 'enhanced',
      authHeader: ctx.cfg.WEBHOOK_AUTH_HEADER,
    };
    const existing = (await ctx.helius!.listWebhooks()).find((w) => w.webhookURL === webhookURL);
    if (existing) {
      await ctx.helius!.editWebhook(existing.webhookID, body);
    } else {
      await ctx.helius!.createWebhook(body);
    }
    lastHash = hash;
    ctx.log(`webhook-sync: ${existing ? 'updated' : 'created'} with ${addresses.length} address(es)`);
  });
}
