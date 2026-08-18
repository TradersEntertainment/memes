import WebSocket from 'ws';
import { PUMPPORTAL_WS_URL } from '@insiderscope/shared';
import type { CurveState, PumpCurveCache } from './pump-cache';

interface PumpPortalMessage {
  txType?: 'create' | 'buy' | 'sell';
  mint?: string;
  traderPublicKey?: string;
  name?: string;
  symbol?: string;
  solAmount?: number;
  tokenAmount?: number;
  marketCapSol?: number;
  vSolInBondingCurve?: number;
  vTokensInBondingCurve?: number;
  pool?: string;
}

export interface NewTokenInfo {
  mint: string;
  creator?: string;
  symbol?: string;
  name?: string;
}

export interface PumpPortalCtx {
  pumpCache: PumpCurveCache;
  log: (msg: string) => void;
  /** Fired for every new pump.fun launch (context wires the creator-watch here). */
  onNewToken?: (info: NewTokenInfo) => void;
}

const MAX_TRACKED = 50;

/**
 * PumpPortal launch stream (Phase 4.1). Every new pump.fun token's curve state
 * lands in the Redis cache, so an insider buy minutes after launch gets an MC
 * and "Launch +Xdk" before DexScreener has ever heard of the mint. New-token
 * events are cache-only — thousands launch per day; a token gets a `tokens`
 * row only once a watched wallet touches it. Mints watched wallets bought are
 * additionally subscribed for trades (LRU-capped) to keep their MC fresh.
 */
export class PumpPortalConsumer {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = 1_000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly tracked = new Set<string>();
  private connected = false;
  private lastEventAtTs: number | null = null;
  private readonly startedAt = Date.now();

  constructor(private readonly ctx: PumpPortalCtx) {}

  /** Health probes for the watchdog. */
  isConnected(): boolean {
    return this.connected;
  }
  lastEventAt(): number | null {
    return this.lastEventAtTs;
  }
  uptimeMs(): number {
    return Date.now() - this.startedAt;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }

  /** Keep this mint's curve state fresh (called when a watched wallet buys it). */
  trackMint(mint: string): void {
    if (this.tracked.has(mint)) return;
    if (this.tracked.size >= MAX_TRACKED) {
      const oldest = this.tracked.values().next().value as string;
      this.tracked.delete(oldest);
      this.send({ method: 'unsubscribeTokenTrade', keys: [oldest] });
    }
    this.tracked.add(mint);
    this.send({ method: 'subscribeTokenTrade', keys: [mint] });
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(PUMPPORTAL_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.backoffMs = 1_000;
      this.ctx.log('pumpportal: connected, subscribing to new launches');
      this.send({ method: 'subscribeNewToken' });
      if (this.tracked.size > 0) {
        this.send({ method: 'subscribeTokenTrade', keys: [...this.tracked] });
      }
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 30_000);
    });

    ws.on('message', (raw) => {
      this.lastEventAtTs = Date.now();
      void this.onMessage(String(raw)).catch((err) =>
        this.ctx.log(`pumpportal message error: ${err}`),
      );
    });

    ws.on('error', (err) => {
      this.ctx.log(`pumpportal socket error: ${err.message}`);
    });

    ws.on('close', () => {
      this.connected = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(this.backoffMs, 60_000) + Math.floor(Math.random() * 500);
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    this.ctx.log(`pumpportal: disconnected, reconnecting in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private async onMessage(raw: string): Promise<void> {
    let msg: PumpPortalMessage;
    try {
      msg = JSON.parse(raw) as PumpPortalMessage;
    } catch {
      return;
    }
    if (!msg.mint || !msg.txType) return;

    if (msg.txType === 'create') {
      const state: CurveState = {
        marketCapSol: msg.marketCapSol ?? 0,
        vSol: msg.vSolInBondingCurve ?? 0,
        vTokens: msg.vTokensInBondingCurve ?? 0,
        creator: msg.traderPublicKey,
        launchTs: new Date(),
        symbol: msg.symbol,
        name: msg.name,
      };
      await this.ctx.pumpCache.set(msg.mint, state);
      this.ctx.onNewToken?.({
        mint: msg.mint,
        creator: msg.traderPublicKey,
        symbol: msg.symbol,
        name: msg.name,
      });
      return;
    }

    // trade update — refresh curve numbers, keep launch metadata
    const existing = await this.ctx.pumpCache.get(msg.mint);
    await this.ctx.pumpCache.set(msg.mint, {
      ...(existing ?? {}),
      marketCapSol: msg.marketCapSol ?? existing?.marketCapSol ?? 0,
      vSol: msg.vSolInBondingCurve ?? existing?.vSol ?? 0,
      vTokens: msg.vTokensInBondingCurve ?? existing?.vTokens ?? 0,
    });
  }
}
