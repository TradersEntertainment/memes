import type { AppCtx } from '../context';
import { buildHealthReport, type HealthProblem } from '../health';
import { getWatchedWallets } from '../watched';
import { resetWebhookSyncState, syncHeliusWebhook } from '../webhook-sync';

/**
 * Pure transition logic: which problems are NEW (notify ⚠️ once) and which
 * previously-reported ones have CLEARED (notify ✅ once). Ongoing problems stay
 * silent — the watchdog never spams the same issue every tick.
 */
export function computeTransitions(
  active: Map<string, string>,
  found: Map<string, string>,
): { appeared: HealthProblem[]; resolved: HealthProblem[] } {
  const appeared: HealthProblem[] = [];
  const resolved: HealthProblem[] = [];
  for (const [key, text] of found) {
    if (!active.has(key)) appeared.push({ key, text });
  }
  for (const [key, text] of active) {
    if (!found.has(key)) resolved.push({ key, text });
  }
  return { appeared, resolved };
}

const activeProblems = new Map<string, string>();

/** Test hook. */
export function resetWatchdogState(): void {
  activeProblems.clear();
}

/**
 * Every 15 minutes: take a health snapshot, verify (and self-heal) the Helius
 * webhook registration, and report only the CHANGES to Telegram. The goal is a
 * system that runs itself: fixes what it can fix, says what it fixed, warns
 * about what it can't, and confirms recovery.
 */
export async function runWatchdog(ctx: AppCtx): Promise<void> {
  const report = await buildHealthReport(ctx);
  const found = new Map(report.problems.map((p) => [p.key, p.text]));

  // Remote check + self-heal: is our webhook actually registered at Helius with
  // the full watched set? (Deleted webhook, stale address list after a crash…)
  if (ctx.helius && ctx.cfg.PUBLIC_BASE_URL && !ctx.helius.circuitState()) {
    try {
      const watchedCount = (await getWatchedWallets(ctx.db)).size;
      if (watchedCount > 0) {
        const url = `${ctx.cfg.PUBLIC_BASE_URL.replace(/\/+$/, '')}/webhook/helius`;
        const mine = (await ctx.helius.listWebhooks()).find((w) => w.webhookURL === url);
        const registered = mine?.accountAddresses?.length ?? 0;
        if (!mine || registered !== watchedCount) {
          ctx.log(
            `watchdog: webhook drift (registered ${registered}, watched ${watchedCount}) — resyncing`,
          );
          resetWebhookSyncState();
          await syncHeliusWebhook(ctx);
          const after = (await ctx.helius.listWebhooks()).find((w) => w.webhookURL === url);
          if (!after) {
            found.set(
              'webhook-reg',
              'Helius webhook kaydı yok ve yeniden kurulamadı — canlı alertler gelmiyor olabilir',
            );
          } else if (!mine) {
            await ctx.alertsQueue.add('custom', {
              custom: {
                text: '🔧 Webhook kaydı Helius tarafında kaybolmuştu — kendim yeniden kurdum, canlı takip devam ediyor.',
              },
            });
          }
        }
      }
    } catch (err) {
      ctx.log(`watchdog: webhook verify failed — ${err}`);
    }
  }

  const { appeared, resolved } = computeTransitions(activeProblems, found);
  activeProblems.clear();
  for (const [key, text] of found) activeProblems.set(key, text);

  if (appeared.length > 0) {
    await ctx.alertsQueue.add('custom', {
      custom: {
        text: ['⚠️ <b>Sorun tespit edildi</b>', ...appeared.map((p) => `• ${p.text}`)].join('\n'),
      },
    });
  }
  if (resolved.length > 0) {
    await ctx.alertsQueue.add('custom', {
      custom: {
        text: ['✅ <b>Düzeldi</b>', ...resolved.map((p) => `• ${p.text.split('—')[0]!.trim()}`)].join(
          '\n',
        ),
      },
    });
  }
}
