import { describe, expect, it } from 'vitest';
import { computeTransitions } from '../src/jobs/watchdog';

const m = (entries: [string, string][]) => new Map(entries);

describe('watchdog transitions', () => {
  it('notifies a new problem exactly once', () => {
    const first = computeTransitions(m([]), m([['helius-circuit', 'kredi bitti']]));
    expect(first.appeared).toEqual([{ key: 'helius-circuit', text: 'kredi bitti' }]);
    expect(first.resolved).toEqual([]);

    // same problem still present next tick → silence
    const second = computeTransitions(
      m([['helius-circuit', 'kredi bitti']]),
      m([['helius-circuit', 'kredi bitti']]),
    );
    expect(second.appeared).toEqual([]);
    expect(second.resolved).toEqual([]);
  });

  it('announces recovery when a problem clears', () => {
    const t = computeTransitions(m([['pumpportal', 'akış kopuk — detay']]), m([]));
    expect(t.appeared).toEqual([]);
    expect(t.resolved).toEqual([{ key: 'pumpportal', text: 'akış kopuk — detay' }]);
  });

  it('handles mixed appear/persist/resolve in one tick', () => {
    const t = computeTransitions(
      m([
        ['db', 'db yok'],
        ['pumpportal', 'kopuk'],
      ]),
      m([
        ['pumpportal', 'kopuk'],
        ['alerts-failed', '12 hata'],
      ]),
    );
    expect(t.appeared).toEqual([{ key: 'alerts-failed', text: '12 hata' }]);
    expect(t.resolved).toEqual([{ key: 'db', text: 'db yok' }]);
  });
});
