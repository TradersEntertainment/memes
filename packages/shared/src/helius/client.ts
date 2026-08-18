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
  private readonly fetchImpl: typeof fetch;
  private readonly log?: (msg: string) => void;

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
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log;
  }

  private sanitize(url: string): string {
    return url.replace(/api-key=[^&]+/g, 'api-key=***');
  }

  private async requestRaw<T>(url: string, init?: RequestInit): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      let netErr: unknown = null;
      try {
        res = await this.fetchImpl(url, init);
      } catch (err) {
        netErr = err;
      }
      if (res?.ok) {
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
        throw netErr instanceof Error ? netErr : new Error(String(netErr));
      }
      const body = await res!.text();
      throw new HeliusHttpError(
        `Helius request failed (${res!.status}) ${this.sanitize(url)}: ${body.slice(0, 300)}`,
        res!.status,
        body,
      );
    }
  }

  private request<T>(url: string, init?: RequestInit): Promise<T> {
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
   * caller can accidentally drain an unbounded history).
   */
  async *iterateHistory(address: string, o: IterateOptions = {}): AsyncGenerator<EnhancedTx[]> {
    const maxPages = o.maxPages ?? Number.POSITIVE_INFINITY;
    let before: string | undefined;
    let pages = 0;
    while (pages < maxPages) {
      const { txs, resumeBefore } = await this.fetchHistoryPage(address, {
        before,
        until: o.until,
        type: o.type,
        limit: 100,
      });
      pages += 1;
      if (txs.length === 0) {
        // Empty page with a resume hint: the searched slot range held no matching
        // events (common with type filters on sparse wallets). Keep walking back.
        if (resumeBefore && resumeBefore !== before) {
          before = resumeBefore;
          continue;
        }
        return;
      }
      yield txs;
      before = txs[txs.length - 1]!.signature;
    }
    this.log?.(`iterateHistory(${address}): page cap ${maxPages} reached, history truncated`);
  }

  /** Drain (bounded) history and return it oldest → newest. */
  async fetchHistoryOldestFirst(address: string, o: IterateOptions = {}): Promise<EnhancedTx[]> {
    const all: EnhancedTx[] = [];
    for await (const page of this.iterateHistory(address, o)) {
      all.push(...page);
      this.log?.(`crawl ${address}: ${all.length} txs...`);
    }
    return all.reverse();
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
