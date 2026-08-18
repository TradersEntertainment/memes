import { getDb, type Db } from '@insiderscope/db';
import { getConfig, HeliusClient, type AppConfig } from '@insiderscope/shared';

export interface AnalyzerCtx {
  db: Db;
  cfg: AppConfig;
  /** Lazy — commands that never touch Helius work without an API key. */
  readonly helius: HeliusClient;
  log: (msg: string) => void;
}

export function buildCtx(): AnalyzerCtx {
  const cfg = getConfig();
  const db = getDb();
  const log = (msg: string) => console.log(`[analyzer] ${msg}`);
  let helius: HeliusClient | null = null;
  return {
    db,
    cfg,
    log,
    get helius(): HeliusClient {
      if (!helius) {
        helius = new HeliusClient({
          apiKey: cfg.HELIUS_API_KEY,
          concurrency: cfg.HELIUS_CONCURRENCY,
          requestsPerSecond: cfg.HELIUS_RPS,
          log,
        });
      }
      return helius;
    },
  };
}
