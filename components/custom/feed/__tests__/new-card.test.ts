// The "new card" rule behind the halo, the bottom glow and the minimap.
import { arrivedAtOf, deriveLastLeftAt, isNewCard } from '../feed-entries';
import type { CardStateRecord } from '@/lib/stores/feed-order-store';

const seen = (at: number): CardStateRecord => ({ state: 'viewed', at } as CardStateRecord);

describe('deriveLastLeftAt', () => {
  it('is the newest seen-mark, not the first or the oldest', () => {
    expect(deriveLastLeftAt({ a: seen(100), b: seen(300), c: seen(200) }, 999)).toBe(300);
  });
  it('is now when nothing was ever seen, so a first launch glows nothing', () => {
    expect(deriveLastLeftAt({}, 999)).toBe(999);
  });
});

describe('isNewCard', () => {
  it('is new only when unseen AND arrived after the reader left', () => {
    expect(isNewCard(301, false, 300)).toBe(true);
    expect(isNewCard(300, false, 300)).toBe(false);
    expect(isNewCard(301, true, 300)).toBe(false);
  });
  it('an unparseable arrival never counts', () => {
    expect(isNewCard(NaN, false, 0)).toBe(false);
  });
});

describe('arrivedAtOf', () => {
  it('prefers the scoring time, then the local creation time', () => {
    expect(arrivedAtOf({ scoredAt: 5, createdAt: '1970-01-01T00:00:00.010Z' })).toBe(5);
    expect(arrivedAtOf({ scoredAt: null, createdAt: '1970-01-01T00:00:00.010Z' })).toBe(10);
  });
});
