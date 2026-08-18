import { describe, expect, it } from 'vitest';
import {
  buildTransferGraph,
  findCreatorLink,
  primaryFunder,
  topFunders,
  type TransferEdgeInput,
} from '../src/funding';

const WALLET = 'wallet';
const CREATOR = 'creator';
const CEX = 'binance-hot';
const isCex = (a: string) => a === CEX;

function graph(edges: TransferEdgeInput[]) {
  return buildTransferGraph(edges);
}

describe('findCreatorLink', () => {
  it('links a direct creator → wallet transfer (1 hop, either direction)', () => {
    const g1 = graph([{ from: CREATOR, to: WALLET, amountSol: 5 }]);
    expect(findCreatorLink(g1, WALLET, CREATOR, isCex)).toEqual({
      linked: true,
      reason: 'path',
      via: [],
    });
    const g2 = graph([{ from: WALLET, to: CREATOR, amountSol: 2 }]);
    expect(findCreatorLink(g2, WALLET, CREATOR, isCex).linked).toBe(true);
  });

  it('links a 2-hop path through an intermediate wallet', () => {
    const g = graph([
      { from: CREATOR, to: 'mule', amountSol: 10 },
      { from: 'mule', to: WALLET, amountSol: 9 },
    ]);
    expect(findCreatorLink(g, WALLET, CREATOR, isCex)).toEqual({
      linked: true,
      reason: 'path',
      via: ['mule'],
    });
  });

  it('does not link beyond maxHops', () => {
    const g = graph([
      { from: CREATOR, to: 'a', amountSol: 10 },
      { from: 'a', to: 'b', amountSol: 9 },
      { from: 'b', to: WALLET, amountSol: 8 },
    ]);
    expect(findCreatorLink(g, WALLET, CREATOR, isCex).linked).toBe(false);
  });

  it('never traverses through a CEX', () => {
    const g = graph([
      { from: CREATOR, to: CEX, amountSol: 100 },
      { from: CEX, to: WALLET, amountSol: 50 },
    ]);
    expect(findCreatorLink(g, WALLET, CREATOR, isCex).linked).toBe(false);
  });

  it('detects a shared funder (as a path with 2 hops, as common-funder with 1)', () => {
    const g = graph([
      { from: 'whale', to: WALLET, amountSol: 20 },
      { from: 'whale', to: CREATOR, amountSol: 30 },
    ]);
    expect(findCreatorLink(g, WALLET, CREATOR, isCex, 2)).toEqual({
      linked: true,
      reason: 'path',
      via: ['whale'],
    });
    expect(findCreatorLink(g, WALLET, CREATOR, isCex, 1)).toEqual({
      linked: true,
      reason: 'common-funder',
      via: ['whale'],
    });
  });

  it('a shared CEX funder proves nothing', () => {
    const g = graph([
      { from: CEX, to: WALLET, amountSol: 20 },
      { from: CEX, to: CREATOR, amountSol: 30 },
    ]);
    expect(findCreatorLink(g, WALLET, CREATOR, isCex).linked).toBe(false);
    expect(findCreatorLink(g, WALLET, CREATOR, isCex, 1).linked).toBe(false);
  });

  it('wallet == creator is trivially linked', () => {
    expect(findCreatorLink(graph([]), WALLET, WALLET, isCex).linked).toBe(true);
  });
});

describe('funder helpers', () => {
  const g = graph([
    { from: CEX, to: WALLET, amountSol: 100 },
    { from: 'whale', to: WALLET, amountSol: 40 },
    { from: 'friend', to: WALLET, amountSol: 4 },
    { from: 'friend', to: WALLET, amountSol: 3 }, // aggregates to 7
  ]);

  it('topFunders excludes CEXes, aggregates and sorts by amount', () => {
    expect(topFunders(g, WALLET, { limit: 5, isCex })).toEqual([
      { address: 'whale', amountSol: 40 },
      { address: 'friend', amountSol: 7 },
    ]);
    expect(topFunders(g, WALLET, { limit: 1, isCex })).toHaveLength(1);
  });

  it('primaryFunder includes CEXes (funding_source display)', () => {
    expect(primaryFunder(g, WALLET)).toEqual({ address: CEX, amountSol: 100 });
    expect(primaryFunder(g, 'nobody')).toBeNull();
  });
});
