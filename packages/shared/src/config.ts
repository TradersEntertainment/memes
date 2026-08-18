import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load the repo-root .env regardless of which app's cwd we run under.
// dotenv never overrides variables that are already set.
let envLoaded = false;
function ensureEnvLoaded(): void {
  if (envLoaded) return;
  loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
  envLoaded = true;
}

const boolFromEnv = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? def : v === 'true' || v === '1'));

const optionalPort = z.preprocess(
  (v) => (v == null || v === '' ? undefined : Number(v)),
  z.number().int().positive().optional(),
);

const EnvSchema = z.object({
  HELIUS_API_KEY: z.string().default(''),
  DATABASE_URL: z
    .string()
    .default('postgres://insiderscope:insiderscope@localhost:5432/insiderscope'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),
  WEBHOOK_AUTH_HEADER: z.string().default(''),
  PUBLIC_BASE_URL: z.string().default(''),
  /** Explicit ingest port; falls back to the platform-injected PORT, then 3001. */
  INGEST_PORT: optionalPort,
  /** Injected by Railway/Heroku-style platforms. */
  PORT: optionalPort,
  /** Injected by Railway once a public domain is generated for the service. */
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  /** Ingest applies committed migrations at startup (idempotent). */
  MIGRATE_ON_BOOT: boolFromEnv(true),

  EARLY_WINDOW_MIN: z.coerce.number().positive().default(30),
  EARLY_MAX_BUYERS: z.coerce.number().int().positive().default(150),
  TRANSFER_MIN_SOL: z.coerce.number().positive().default(5),
  SELL_ALERTS: boolFromEnv(true),
  PROBATION_EXPIRY_DAYS: z.coerce.number().positive().default(14),
  MAX_CHILDREN_PER_PARENT: z.coerce.number().int().positive().default(3),
  MIN_SCORED_POSITIONS: z.coerce.number().int().positive().default(3),
  ALERT_DEBOUNCE_SEC: z.coerce.number().positive().default(10),
  ALERT_MAX_AGE_MIN: z.coerce.number().positive().default(15),
  RECONCILE_INTERVAL_MIN: z.coerce.number().positive().default(5),
  HELIUS_CONCURRENCY: z.coerce.number().int().positive().default(5),
  /** Requests per second ceiling — match your Helius plan (free ≈ 10, paid higher). */
  HELIUS_RPS: z.coerce.number().int().positive().default(10),
  HELIUS_MAX_PAGES_TOKEN: z.coerce.number().int().positive().default(300),
  HELIUS_MAX_PAGES_WALLET: z.coerce.number().int().positive().default(20),
  /**
   * Page cap for funding-graph crawls. Deliberately lower than the wallet cap:
   * a dormant insider wallet reaches the launch window in a few pages, while a
   * hyperactive one never will — and it gets blacklisted on trade count anyway,
   * so paging deep into it only burns credits.
   */
  FUNDING_MAX_PAGES: z.coerce.number().int().positive().default(8),
  FUNDING_MAX_FUNDERS: z.coerce.number().int().positive().default(10),
  /** Days before a token's launch to include when crawling funding transfers. */
  FUNDING_LOOKBACK_DAYS: z.coerce.number().positive().default(30),
  /**
   * Directory scanned for candidate-token CSVs on every pipeline pass. Point it
   * at a persistent volume so hand-curated lists survive redeploys; ignored when
   * the directory does not exist.
   */
  TOKENS_DIR: z.string().default('/data/tokens'),
  /** Lifetime swap count above which a wallet is treated as a bot and blacklisted. */
  SCORE_MAX_TRADES: z.coerce.number().int().positive().default(500),
  /** Trade count at which the selectivity factor reaches zero. */
  SCORE_SELECTIVITY_TRADES: z.coerce.number().int().positive().default(200),
  /** Rescore a wallet at most this often unless it traded in the meantime. */
  SCORE_REFRESH_DAYS: z.coerce.number().positive().default(3),
  PUMPPORTAL_ENABLED: boolFromEnv(true),
  DISCOVER_MIN_MC_USD: z.coerce.number().positive().default(10_000_000),
  SOL_PRICE_FALLBACK_USD: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number(v);
      return v && Number.isFinite(n) && n > 0 ? n : null;
    }),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function resolveIngestPort(cfg: AppConfig): number {
  return cfg.INGEST_PORT ?? cfg.PORT ?? 3001;
}

export interface ScoringConfig {
  bigTokenMcUsd: number;
  maxTradesForSelectivity: number;
  overtradeBlacklist: number;
  minWinRate: number;
  minDecidedForWinRateBlacklist: number;
  sniperSeconds: number;
  idealMaxSeconds: number;
  lateSeconds: number;
  insiderThreshold: number;
  watchThreshold: number;
  minScoredPositions: number;
}

export function scoringConfig(cfg: AppConfig): ScoringConfig {
  return {
    bigTokenMcUsd: cfg.DISCOVER_MIN_MC_USD,
    maxTradesForSelectivity: cfg.SCORE_SELECTIVITY_TRADES,
    overtradeBlacklist: cfg.SCORE_MAX_TRADES,
    minWinRate: 0.3,
    minDecidedForWinRateBlacklist: 5,
    sniperSeconds: 3,
    idealMaxSeconds: 600,
    lateSeconds: 1800,
    insiderThreshold: 70,
    watchThreshold: 50,
    minScoredPositions: cfg.MIN_SCORED_POSITIONS,
  };
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!cached) {
    ensureEnvLoaded();
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new Error(`Invalid environment configuration — ${detail}`);
    }
    const data = parsed.data;
    // On Railway the public domain arrives as RAILWAY_PUBLIC_DOMAIN — use it as
    // the webhook base unless the user set one explicitly.
    if (!data.PUBLIC_BASE_URL && data.RAILWAY_PUBLIC_DOMAIN) {
      data.PUBLIC_BASE_URL = `https://${data.RAILWAY_PUBLIC_DOMAIN}`;
    }
    cached = data;
  }
  return cached;
}

/** Test hook: re-read process.env on next getConfig(). */
export function resetConfigCache(): void {
  cached = null;
}
