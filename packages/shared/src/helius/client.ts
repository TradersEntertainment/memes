import PQueue from 'p-queue';
import { HELIUS_API_BASE, HELIUS_RPC_BASE } from '../constants';
import { sleep } from '../utils';
import type { EnhancedTx } from './types';

export interface HeliusWebhookConfig {
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: string;
  authHeader?: string;
}

export interface HeliusWebhook extends HeliusWebhookConfig {
  webhookID: string;
}

export interface HistoryOptions {
  before?: string;
  until?: string;
  limit?: number;
  type?: 'SWAP' | 'TRANSFER';
}

export interface IterateOptions {
  until?: string;
  maxPages?: number;
  type?: 'SWAP' | 'TRANSFER';
}

export class HeliusHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'HeliusHttpError';
  }
}

/**
 * Thrown fast (no network, no retries) while the credit/rate circuit is open.
 * Batch loops treat it as "stop the whole run and come back later" — retrying
 * 250 wallets against an exhausted API only burns time and retry budget.
 */
export class HeliusCircuitOpenError extends Error {
  constructor(
    readonly untilTs: number,
    readonly reason: string,
  ) {
    super(`Helius circuit open until ${new Date(untilTs).toISOString()}: ${reason}`);
    this.name = 'HeliusCircuitOpenError';
  }
}

/**
 * Helius answers a history page with no events in the searched slot range with
 * HTTP 404 plus the signature to resume from — a "keep paging" signal, not an
 * error. Returns that signature when the body carries one.
 */
export function parseResumeSignature(body: string): string | null {
  const match = /before-signature[^]*?set to ([1-9A-HJ-NP-Za-km-z]{32,90})/.exec(body);
  return match?.[1] ?? null;
}

export interface HeliusClientOptions {
  apiKey: string;
  concurrency?: number;
  /** Hard ceiling on requests per second — the thing that actually prevents 429s. */
  requestsPerSecond?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  /** Consecutive post-retry failures before the circuit opens (default 8). */
  circuitThreshold?: number;
  /** How long the circuit stays open after repeated failures (default 15 min). */
  circuitCooldownMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

/**
 * Thin Helius client. Every request funnels through one p-queue so total
 * concurrency stays bounded no matter how many callers fan out, and 429/5xx
 * responses retry with exponential backoff (honoring Retry-After).
 */
export class HeliusClient {
  private readonly queue: PQueue;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly circuitThreshold: number;
  private readonly circuitCooldownMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log?: (msg: string) => void;

  // Credit/rate circuit breaker. 401/402/403 (bad key, credits exhausted) open
  // it immediately for an hour; a streak of post-retry failures (typically 429s
  // that never clear) opens it for the cooldown. Any success closes it.
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private circuitReason = '';

  constructor(opts: HeliusClientOptions) {
    if (!opts.apiKey) {
      throw new Error('HELIUS_API_KEY is not set — add it to .env');
    }
    this.apiKey = opts.apiKey;
    // Concurrency alone cannot prevent 429s: five slots each finishing in ~150ms
    // is ~30 req/s, far above a small plan's ceiling. The interval cap is what
    // keeps the crawl inside the plan's budget, so retries stay rare.
    const rps = opts.requestsPerSecond ?? 10;
    this.queue = new PQueue({
      concurrency: opts.concurrency ?? 5,
      interval: 1000,
      intervalCap: rps,
      carryoverConcurrencyCount: true,
    });
    this.maxRetries = opts.maxRetries ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.circuitThreshold = opts.circuitThreshold ?? 8;
    this.circuitCooldownMs = opts.circuitCooldownMs ?? 15 * 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log;
  }

  /** Non-null while the credit/rate circuit is open. */
  circuitState(): { untilTs: number; reason: string } | null {
    return Date.now() < this.circuitOpenUntil
      ? { untilTs: this.circuitOpenUntil, reason: this.circuitReason }
      : null;
  }

  private assertCircuitClosed(): void {
    const open = this.circuitState();
    if (open) throw new HeliusCircuitOpenError(open.untilTs, open.reason);
  }

  private openCircuit(durationMs: number, reason: string): void {
    this.circuitOpenUntil = Date.now() + durationMs;
    this.circuitReason = reason;
    this.consecutiveFailures = 0;
    this.log?.(
      `helius circuit OPEN for ${Math.round(durationMs / 60_000)}min — ${reason}`,
    );
  }

  private recordTerminalFailure(err: unknown): void {
    if (err instanceof HeliusHttpError && [401, 402, 403].includes(err.status)) {
      this.openCircuit(60 * 60_000, `HTTP ${err.status} — api key invalid or credits exhausted`);
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.circuitThreshold) {
      this.openCircuit(
        this.circuitCooldownMs,
        `${this.consecutiveFailures} consecutive failures after retries (rate limit or outage)`,
      );
    }
  }

  private sanitize(url: string): string {
    return url.replace(/api-key=[^&]+/g, 'api-key=***');
  }

  private async requestRaw<T>(url: string, init?: RequestInit): Promise<T> {
    this.assertCircuitClosed();
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      let netErr: unknown = null;
      try {
        res = await this.fetchImpl(url, init);
      } catch (err) {
        netErr = err;
      }
      if (res?.ok) {
        this.consecutiveFailures = 0;
        return (await res.json()) as T;
      }
      const retryable = netErr != null || res!.status === 429 || res!.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        const retryAfterSec = res ? Number(res.headers.get('retry-after')) : 0;
        const delay =
          retryAfterSec > 0
            ? retryAfterSec * 1000
            : this.baseDelayMs * 2 ** attempt + Math.random() * 250;
        this.log?.(
          `helius retry ${attempt + 1}/${this.maxRetries} in ${Math.round(delay)}ms (${
            res ? `status ${res.status}` : 'network error'
          })`,
        );
        await sleep(delay);
        continue;
      }
      if (netErr) {
        const wrapped = netErr instanceof Error ? netErr : new Error(String(netErr));
        this.recordTerminalFailure(wrapped);
        throw wrapped;
      }
      const body = await res!.text();
      const httpErr = new HeliusHttpError(
        `Helius request failed (${res!.status}) ${this.sanitize(url)}: ${body.slice(0, 300)}`,
        res!.status,
        body,
      );
      // 404 is a paging signal on history endpoints, never an availability problem.
      if (res!.status !== 404) this.recordTerminalFailure(httpErr);
      throw httpErr;
    }
  }

  private request<T>(url: string, init?: RequestInit): Promise<T> {
    this.assertCircuitClosed(); // fast-fail before joining the rate-limited queue
    return this.queue.add(() => this.requestRaw<T>(url, init)) as Promise<T>;
  }

  /** GET /v0/addresses/{address}/transactions — parsed txs, newest first. */
  async getParsedTransactions(address: string, o: HistoryOptions = {}): Promise<EnhancedTx[]> {
    return (await this.fetchHistoryPage(address, o)).txs;
  }

  /**
   * One history page. An empty `txs` with `resumeBefore` set means "no events in
   * the range searched, continue from this signature" — Helius signals that with
   * a 404 that must not abort the crawl.
   */
  private async fetchHistoryPage(
    address: string,
    o: HistoryOptions = {},
  ): Promise<{ txs: EnhancedTx[]; resumeBefore?: string }> {
    const params = new URLSearchParams({
      'api-key': this.apiKey,
      limit: String(o.limit ?? 100),
    });
    if (o.before) params.set('before', o.before);
    if (o.until) params.set('until', o.until);
    if (o.type) params.set('type', o.type);
    try {
      const txs = await this.request<EnhancedTx[]>(
        `${HELIUS_API_BASE}/v0/addresses/${address}/transactions?${params}`,
      );
      return { txs };
    } catch (err) {
      if (err instanceof HeliusHttpError && err.status === 404) {
        const resume = parseResumeSignature(err.body);
        if (resume) return { txs: [], resumeBefore: resume };
        return { txs: [] }; // nothing left to search
      }
      throw err;
    }
  }

  /**
   * Paginate an address's parsed history newest → oldest via the `before` cursor.
   * Stops on an empty page or when `maxPages` is hit (cap enforced here so no
   * caller can accidentally drain an unbounded history). The generator's return
   * value says whether the CAP stopped it (true) — a short or empty final page
   * means the source genuinely dried up, so hitting the cap on one is not a
   * truncation.
   */
  async *iterateHistory(
    address: string,
    o: IterateOptions = {},
  ): AsyncGenerator<EnhancedTx[], boolean> {
    const maxPages = o.maxPages ?? Number.POSITIVE_INFINITY;
    let before: string | undefined;
    let pages = 0;
    let lastPageFull = false;
    while (pages < maxPages) {
      const { txs, resumeBefore } = await this.fetchHistoryPage(address, {
        before,
        until: o.until,
        type: o.type,
        limit: 100,
      });
      pages += 1;
      lastPageFull = txs.length >= 100;
      if (txs.length === 0) {
        // Empty page with a resume hint: the searched slot range held no matching
        // events (common with type filters on sparse wallets). Keep walking back.
        if (resumeBefore && resumeBefore !== before) {
          before = resumeBefore;
          continue;
        }
        return false;
      }
      yield txs;
      before = txs[txs.length - 1]!.signature;
    }
    if (lastPageFull) {
      this.log?.(`iterateHistory(${address}): page cap ${maxPages} reached, history truncated`);
    }
    return lastPageFull;
  }

  /** Drain (bounded) history and return it oldest → newest. */
  async fetchHistoryOldestFirst(address: string, o: IterateOptions = {}): Promise<EnhancedTx[]> {
    return (await this.fetchHistoryOldestFirstDetailed(address, o)).txs;
  }

  /**
   * Same, plus whether the page cap cut the crawl short. When it did, the
   * "oldest" tx in the result is NOT the address's real beginning — callers
   * doing launch detection must treat a truncated drain as unusable rather
   * than fabricate a launch from a mid-history transaction.
   */
  async fetchHistoryOldestFirstDetailed(
    address: string,
    o: IterateOptions = {},
  ): Promise<{ txs: EnhancedTx[]; truncated: boolean }> {
    const all: EnhancedTx[] = [];
    const it = this.iterateHistory(address, o);
    let step = await it.next();
    while (!step.done) {
      all.push(...step.value);
      this.log?.(`crawl ${address}: ${all.length} txs...`);
      step = await it.next();
    }
    return { txs: all.reverse(), truncated: step.value === true };
  }

  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.request<{ result?: T; error?: { message?: string } }>(
      `${HELIUS_RPC_BASE}/?api-key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params }),
      },
    );
    if (res.error) {
      throw new Error(`RPC ${method} failed: ${res.error.message ?? 'unknown error'}`);
    }
    return res.result as T;
  }

  async getTokenSupply(mint: string): Promise<{ uiAmount: number; decimals: number }> {
    const r = await this.rpc<{
      value: { uiAmount: number | null; uiAmountString?: string; decimals: number };
    }>('getTokenSupply', [mint]);
    return {
      uiAmount: r.value.uiAmount ?? Number(r.value.uiAmountString ?? 0),
      decimals: r.value.decimals,
    };
  }

  // --- Webhook admin API ---

  listWebhooks(): Promise<HeliusWebhook[]> {
    return this.request<HeliusWebhook[]>(`${HELIUS_API_BASE}/v0/webhooks?api-key=${this.apiKey}`);
  }

  createWebhook(cfg: HeliusWebhookConfig): Promise<HeliusWebhook> {
    return this.request<HeliusWebhook>(`${HELIUS_API_BASE}/v0/webhooks?api-key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
    });
  }

  editWebhook(id: string, cfg: HeliusWebhookConfig): Promise<HeliusWebhook> {
    return this.request<HeliusWebhook>(
      `${HELIUS_API_BASE}/v0/webhooks/${id}?api-key=${this.apiKey}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cfg),
      },
    );
  }
}
