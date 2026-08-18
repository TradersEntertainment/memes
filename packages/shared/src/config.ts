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
  INGEST_PORT: z.coerce.number().int().positive().default(3001),

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
  HELIUS_MAX_PAGES_TOKEN: z.coerce.number().int().positive().default(300),
  HELIUS_MAX_PAGES_WALLET: z.coerce.number().int().positive().default(20),
  FUNDING_MAX_FUNDERS: z.coerce.number().int().positive().default(10),
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
    maxTradesForSelectivity: 200,
    overtradeBlacklist: 500,
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
    cached = parsed.data;
  }
  return cached;
}

/** Test hook: re-read process.env on next getConfig(). */
export function resetConfigCache(): void {
  cached = null;
}
