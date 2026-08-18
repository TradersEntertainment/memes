import type { Redis } from 'ioredis';

export interface CurveState {
  marketCapSol: number;
  vSol: number;
  vTokens: number;
  creator?: string;
  launchTs?: Date;
  symbol?: string;
  name?: string;
}

const KEY_PREFIX = 'is:curve:';
const TTL_SEC = 48 * 3600;

/**
 * Redis-backed cache of pump.fun bonding-curve state, fed by the PumpPortal
 * stream. Lets alerts show MC + "Launch +Xdk" for tokens DexScreener hasn't
 * listed yet. 48h TTL — a token either graduates into DexScreener coverage or
 * stops mattering.
 */
export class PumpCurveCache {
  constructor(private readonly redis: Redis) {}

  async set(mint: string, state: CurveState): Promise<void> {
    const payload = JSON.stringify({
      ...state,
      launchTs: state.launchTs?.toISOString() ?? null,
    });
    await this.redis.set(`${KEY_PREFIX}${mint}`, payload, 'EX', TTL_SEC);
  }

  async get(mint: string): Promise<CurveState | null> {
    const raw = await this.redis.get(`${KEY_PREFIX}${mint}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as CurveState & { launchTs: string | null };
      return {
        ...parsed,
        launchTs: parsed.launchTs ? new Date(parsed.launchTs) : undefined,
      };
    } catch {
      return null;
    }
  }
}
