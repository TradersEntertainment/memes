import { and, count, eq, inArray, wallets } from '@insiderscope/db';
import type { AppCtx } from './context';

export interface HealthProblem {
  key: string;
  text: string;
}

export interface HealthReport {
  lines: string[];
  problems: HealthProblem[];
}

/**
 * One snapshot of every component, from local state (no Helius credits spent).
 * Used by the boot notice, the /health command, and the watchdog — the watchdog
 * turns `problems` into ⚠️/✅ Telegram transitions.
 */
export async function buildHealthReport(ctx: AppCtx): Promise<HealthReport> {
  const problems: HealthProblem[] = [];
  const lines: string[] = [];

  let watched = 0;
  try {
    const rows = await ctx.db
      .select({ n: count() })
      .from(wallets)
      .where(
        and(eq(wallets.isActive, true), inArray(wallets.tier, ['insider', 'watch', 'probation'])),
      );
    watched = rows[0]?.n ?? 0;
    lines.push(`🗄️ Veritabanı bağlı — ${watched} cüzdan izleniyor`);
  } catch {
    lines.push('🗄️ Veritabanına ERİŞİLEMİYOR');
    problems.push({ key: 'db', text: 'Veritabanına erişilemiyor' });
  }

  if (!ctx.helius) {
    lines.push('🔑 Helius: anahtar yok — canlı takip ve analiz KAPALI');
    problems.push({ key: 'helius-key', text: 'HELIUS_API_KEY tanımlı değil' });
  } else {
    const circuit = ctx.helius.circuitState();
    if (circuit) {
      const until = new Date(circuit.untilTs).toISOString().slice(11, 16);
      lines.push(`⛔ Helius: erişim durduruldu (~${until} UTC'ye kadar)`);
      problems.push({
        key: 'helius-circuit',
        text: `Helius erişimi durduruldu — ${circuit.reason}. ~${until} UTC'de otomatik denenecek; kredi: dashboard.helius.dev`,
      });
    } else {
      lines.push('🔑 Helius: erişim açık');
    }
  }

  if (!ctx.cfg.PUBLIC_BASE_URL) {
    lines.push('🔗 Webhook: PUBLIC_BASE_URL yok — domain oluşturulmamış');
    if (watched > 0) {
      problems.push({
        key: 'webhook-url',
        text: 'İzlenen cüzdan var ama PUBLIC_BASE_URL boş — webhook kayıtlı değil, canlı alertler gelmez',
      });
    }
  } else {
    lines.push(`🔗 Webhook hedefi: ${ctx.cfg.PUBLIC_BASE_URL}/webhook/helius`);
  }

  if (ctx.cfg.PUMPPORTAL_ENABLED && ctx.pumpPortal) {
    const pp = ctx.pumpPortal;
    const graceMs = 5 * 60_000;
    const staleMs = 15 * 60_000;
    const lastAge = pp.lastEventAt() != null ? Date.now() - pp.lastEventAt()! : null;
    if (!pp.isConnected() && pp.uptimeMs() > graceMs) {
      lines.push('📡 PumpPortal: BAĞLI DEĞİL (otomatik yeniden bağlanıyor)');
      problems.push({
        key: 'pumpportal',
        text: 'PumpPortal launch akışı kopuk — yeni token/dev alertleri şu an gelmiyor (otomatik yeniden bağlanma sürüyor)',
      });
    } else if (pp.isConnected() && pp.uptimeMs() > staleMs && (lastAge == null || lastAge > staleMs)) {
      lines.push('📡 PumpPortal: bağlı ama akış SESSİZ');
      problems.push({
        key: 'pumpportal',
        text: 'PumpPortal bağlı görünüyor ama 15 dk+ hiç olay gelmedi — akış donmuş olabilir',
      });
    } else {
      lines.push('📡 PumpPortal: canlı');
    }
  } else {
    lines.push('📡 PumpPortal: kapalı (PUMPPORTAL_ENABLED=false)');
  }

  try {
    const alertCounts = await ctx.alertsQueue.getJobCounts('failed', 'waiting');
    const pipeCounts = await ctx.pipelineQueue.getJobCounts('active', 'waiting');
    const scanning = (pipeCounts.active ?? 0) > 0;
    lines.push(
      `⚙️ Kuyruklar: ${alertCounts.waiting ?? 0} alert bekliyor, ${alertCounts.failed ?? 0} hatalı · analiz ${
        scanning ? 'ÇALIŞIYOR' : (pipeCounts.waiting ?? 0) > 0 ? 'sırada' : 'boşta'
      }`,
    );
    if ((alertCounts.failed ?? 0) >= 10) {
      problems.push({
        key: 'alerts-failed',
        text: `Alert kuyruğunda ${alertCounts.failed} başarısız gönderim birikti (Telegram token/chat id kontrol edilmeli)`,
      });
    }
  } catch {
    lines.push('⚙️ Kuyruklar: Redis durumu OKUNAMADI');
    problems.push({ key: 'redis', text: 'Redis kuyruk durumu okunamıyor' });
  }

  return { lines, problems };
}
