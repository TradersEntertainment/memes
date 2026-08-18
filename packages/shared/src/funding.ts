/**
 * Pure funding-graph logic. Edges are SOL transfers; direction matters for
 * "who funded whom", but creator-link paths are walked undirected (money can
 * flow creator→insider or insider→creator). CEX wallets are terminal: never
 * traversed through and never counted as a common funder — half of Solana is
 * "linked" through Binance otherwise.
 */

export interface TransferEdgeInput {
  from: string;
  to: string;
  amountSol: number;
}

export interface TransferGraph {
  /** out.get(a) = receivers of a's SOL with total amounts. */
  out: Map<string, Map<string, number>>;
  /** in.get(a) = funders of a with total amounts. */
  in: Map<string, Map<string, number>>;
}

export function buildTransferGraph(edges: TransferEdgeInput[]): TransferGraph {
  const g: TransferGraph = { out: new Map(), in: new Map() };
  const bump = (m: Map<string, Map<string, number>>, a: string, b: string, amt: number) => {
    const inner = m.get(a) ?? new Map<string, number>();
    inner.set(b, (inner.get(b) ?? 0) + amt);
    m.set(a, inner);
  };
  for (const e of edges) {
    if (!e.from || !e.to || e.from === e.to || e.amountSol <= 0) continue;
    bump(g.out, e.from, e.to, e.amountSol);
    bump(g.in, e.to, e.from, e.amountSol);
  }
  return g;
}

export interface CreatorLinkResult {
  linked: boolean;
  reason?: 'path' | 'common-funder';
  /** Intermediate wallets on the path (empty = direct), or the common funder. */
  via?: string[];
}

/**
 * Is `wallet` connected to `creator` within `maxHops` transfer edges (undirected),
 * or do they share a direct (1-hop) non-CEX funder?
 */
export function findCreatorLink(
  g: TransferGraph,
  wallet: string,
  creator: string,
  isCex: (address: string) => boolean,
  maxHops = 2,
): CreatorLinkResult {
  if (!wallet || !creator) return { linked: false };
  if (wallet === creator) return { linked: true, reason: 'path', via: [] };

  const neighborsOf = (node: string): Set<string> => {
    const s = new Set<string>();
    for (const k of g.out.get(node)?.keys() ?? []) s.add(k);
    for (const k of g.in.get(node)?.keys() ?? []) s.add(k);
    return s;
  };

  const visited = new Set<string>([wallet]);
  let frontier: { node: string; path: string[] }[] = [{ node: wallet, path: [] }];
  for (let hop = 1; hop <= maxHops; hop++) {
    const next: { node: string; path: string[] }[] = [];
    for (const { node, path } of frontier) {
      for (const nb of neighborsOf(node)) {
        if (nb === creator) return { linked: true, reason: 'path', via: path };
        if (visited.has(nb) || isCex(nb)) continue;
        visited.add(nb);
        next.push({ node: nb, path: [...path, nb] });
      }
    }
    frontier = next;
  }

  const walletFunders = new Set(
    [...(g.in.get(wallet)?.keys() ?? [])].filter((a) => !isCex(a) && a !== creator),
  );
  for (const funder of g.in.get(creator)?.keys() ?? []) {
    if (walletFunders.has(funder) && !isCex(funder) && funder !== wallet) {
      return { linked: true, reason: 'common-funder', via: [funder] };
    }
  }
  return { linked: false };
}

/** Direct funders of a wallet, largest total SOL first, CEX excluded. */
export function topFunders(
  g: TransferGraph,
  wallet: string,
  opts: { limit: number; isCex: (address: string) => boolean },
): { address: string; amountSol: number }[] {
  const funders = [...(g.in.get(wallet)?.entries() ?? [])]
    .filter(([address]) => !opts.isCex(address))
    .map(([address, amountSol]) => ({ address, amountSol }))
    .sort((a, b) => b.amountSol - a.amountSol);
  return funders.slice(0, opts.limit);
}

/** The wallet's single largest funder including CEXes (funding_source display). */
export function primaryFunder(
  g: TransferGraph,
  wallet: string,
): { address: string; amountSol: number } | null {
  const funders = [...(g.in.get(wallet)?.entries() ?? [])].sort((a, b) => b[1] - a[1]);
  const first = funders[0];
  return first ? { address: first[0], amountSol: first[1] } : null;
}
