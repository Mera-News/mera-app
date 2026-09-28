// The open-ready target: 50 relevant articles published in the last 6h, and
// no more. And the ObjectId insert-time prefilter that keeps an older article
// from ever being charged.

import {
  computeOpenReadiness,
  isInsertedWithinWindow,
  objectIdTimestampMs,
  plannedMeteredFetch,
  FRESH_WINDOW_MS,
  YIELD_DEFAULT,
} from '../open-ready-target';

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

function objectIdAt(ms: number): string {
  return Math.floor(ms / 1000).toString(16).padStart(8, '0') + '0000000000000000';
}

describe('the ObjectId prefilter', () => {
  it('reads the insert time out of the first 4 bytes', () => {
    expect(objectIdTimestampMs(objectIdAt(NOW))).toBe(Math.floor(NOW / 1000) * 1000);
  });

  it('keeps an id inserted inside the window', () => {
    expect(isInsertedWithinWindow(objectIdAt(NOW - 5 * HOUR), NOW)).toBe(true);
  });

  it('drops an id inserted before the window, so it is never hydrated and never charged', () => {
    expect(isInsertedWithinWindow(objectIdAt(NOW - FRESH_WINDOW_MS - 1000), NOW)).toBe(false);
  });

  it('drops anything that is not an ObjectId rather than guessing', () => {
    expect(objectIdTimestampMs('art-1')).toBeNull();
    expect(isInsertedWithinWindow('art-1', NOW)).toBe(false);
  });
});

function rows(n: number, row: Record<string, unknown>) {
  return Array.from({ length: n }, () => ({ ...row }));
}

describe('what counts toward the target', () => {
  const fresh = NOW - HOUR;
  const old = NOW - 7 * HOUR;

  it('counts rows that pass the per-row gate and were published in the window', () => {
    const r = computeOpenReadiness(
      [
        ...rows(3, { status: 'complete', relevance: 0.6, first_pub_date: fresh }),
        ...rows(2, { status: 'reason_pending', relevance: 0.5, first_pub_date: fresh }),
        ...rows(4, { status: 'complete', relevance: 0.2, first_pub_date: fresh }), // below the gate
        ...rows(5, { status: 'complete', relevance: 0.9, first_pub_date: old }), // too old
      ],
      NOW,
    );
    expect(r.relevant6h).toBe(5);
  });

  it('judges a v3 row at its own 0.55 gate', () => {
    const r = computeOpenReadiness(
      [{ status: 'complete', relevance: 0.5, first_pub_date: fresh, scored_with_v3: 1 }],
      NOW,
    );
    expect(r.relevant6h).toBe(0);
  });

  it('leaves out excluded and already-read rows entirely', () => {
    const r = computeOpenReadiness(
      [
        { status: 'excluded', relevance: 0.9, first_pub_date: fresh },
        { status: 'already_read', relevance: 0.9, first_pub_date: fresh },
      ],
      NOW,
    );
    expect(r).toMatchObject({ relevant6h: 0, pending6h: 0, yieldSample: 0 });
  });

  it('counts fresh unscored rows as pending', () => {
    const r = computeOpenReadiness(rows(7, { status: 'unscored', relevance: 0, first_pub_date: fresh }), NOW);
    expect(r.pending6h).toBe(7);
  });
});

describe('the measured yield', () => {
  it('uses the default until 20 rows have been scored', () => {
    const r = computeOpenReadiness(rows(19, { status: 'complete', relevance: 0.9, first_pub_date: NOW }), NOW);
    expect(r.yield).toBe(YIELD_DEFAULT);
  });

  it("is this device's own gate-pass ratio once there is a sample", () => {
    const r = computeOpenReadiness(
      [
        ...rows(10, { status: 'complete', relevance: 0.9, first_pub_date: NOW }),
        ...rows(30, { status: 'complete', relevance: 0.1, first_pub_date: NOW }),
      ],
      NOW,
    );
    expect(r.yield).toBeCloseTo(0.25);
  });
});

describe('how much to fetch', () => {
  it('fetches nothing once 50 relevant fresh articles are ready', () => {
    expect(plannedMeteredFetch({ relevant6h: 50, pending6h: 0, yield: 0.33, yieldSample: 100 }, 50)).toBe(0);
  });

  it('counts pending rows at the yield, so pending results stop an over-fetch', () => {
    // 30 relevant + 0.5 * 40 pending = 50 expected.
    expect(plannedMeteredFetch({ relevant6h: 30, pending6h: 40, yield: 0.5, yieldSample: 100 }, 50)).toBe(0);
  });

  it('sizes the fetch by the measured yield', () => {
    // 40 relevant, need 10 more at 0.5 → 20 articles.
    expect(plannedMeteredFetch({ relevant6h: 40, pending6h: 0, yield: 0.5, yieldSample: 100 }, 50)).toBe(20);
    // Same gap at 0.25 → 40.
    expect(plannedMeteredFetch({ relevant6h: 40, pending6h: 0, yield: 0.25, yieldSample: 100 }, 50)).toBe(40);
  });

  it('never exceeds what the allowance lets this run spend', () => {
    expect(plannedMeteredFetch({ relevant6h: 0, pending6h: 0, yield: 0.33, yieldSample: 0 }, 50)).toBe(50);
    expect(plannedMeteredFetch({ relevant6h: 0, pending6h: 0, yield: 0.33, yieldSample: 0 }, 12)).toBe(12);
  });
});
