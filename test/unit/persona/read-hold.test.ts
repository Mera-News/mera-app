const mockStore = new Map<string, string>();
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setSetting: jest.fn(async (k: string, v: string) => {
    mockStore.set(k, v);
  }),
}));

import {
  computeHoldUntil,
  getReadHold,
  hydrateReadHold,
  isReadHeld,
  nextUtcMidnight,
  READ_HOLD_KEY,
  READ_HOLD_MAX_JITTER_MS,
  resetDayWord,
  resetReadHold,
  serverNowFromDateHeader,
  setReadHold,
} from '@/lib/subscription/read-hold';

const NOW = Date.UTC(2026, 9, 15, 20, 0, 0);
const MIDNIGHT = Date.UTC(2026, 9, 16, 0, 0, 0);

beforeEach(() => {
  mockStore.clear();
  resetReadHold();
  jest.useFakeTimers({ now: NOW });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('computeHoldUntil', () => {
  it('moves the server reset onto the device clock and adds the jitter', () => {
    // Device runs 5 min fast: the server says 19:55 when the device says 20:00.
    const serverNow = NOW - 5 * 60_000;
    expect(computeHoldUntil({ resetAt: MIDNIGHT, deviceNow: NOW, serverNow, jitterMs: 0 })).toBe(
      MIDNIGHT + 5 * 60_000,
    );
    expect(computeHoldUntil({ resetAt: MIDNIGHT, deviceNow: NOW, serverNow, jitterMs: 60_000 })).toBe(
      MIDNIGHT + 6 * 60_000,
    );
  });

  it('clamps the jitter to 0..30 min and the reset to one day ahead', () => {
    expect(computeHoldUntil({ resetAt: MIDNIGHT, deviceNow: NOW, jitterMs: 10 * 3_600_000 })).toBe(
      MIDNIGHT + READ_HOLD_MAX_JITTER_MS,
    );
    const far = NOW + 30 * 86_400_000;
    expect(computeHoldUntil({ resetAt: far, deviceNow: NOW, jitterMs: 0 })).toBe(NOW + 86_400_000);
  });
});

describe('date helpers', () => {
  it('nextUtcMidnight is strictly after now', () => {
    expect(nextUtcMidnight(NOW)).toBe(MIDNIGHT);
    expect(nextUtcMidnight(MIDNIGHT)).toBe(MIDNIGHT + 86_400_000);
  });

  it('resetDayWord reads the local date', () => {
    expect(resetDayWord(NOW + 60_000, NOW)).toBe('today');
    expect(resetDayWord(NOW + 86_400_000, NOW)).toBe('tomorrow');
  });

  it('parses a Date header and refuses garbage', () => {
    expect(serverNowFromDateHeader('Thu, 15 Oct 2026 19:55:00 GMT')).toBe(NOW - 5 * 60_000);
    expect(serverNowFromDateHeader('nonsense')).toBeNull();
    expect(serverNowFromDateHeader(null)).toBeNull();
  });
});

describe('the hold', () => {
  it('is held until the jittered end, then shows nothing', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    await setReadHold({ resetAt: MIDNIGHT, used: 1 });
    expect(isReadHeld()).toBe(true);
    expect(getReadHold()).toEqual({ resetAt: MIDNIGHT, used: 1 });
    expect(isReadHeld(MIDNIGHT + 14 * 60_000)).toBe(true);
    expect(isReadHeld(MIDNIGHT + 15 * 60_000)).toBe(false);
    jest.setSystemTime(MIDNIGHT + 15 * 60_000);
    // A new UTC day: yesterday's used no longer reads as today's.
    expect(getReadHold()).toEqual({ resetAt: null, used: null });
  });

  it('keeps the jitter when the same resetAt is reported again', async () => {
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    await setReadHold({ resetAt: MIDNIGHT });
    random.mockReturnValue(1);
    await setReadHold({ resetAt: MIDNIGHT });
    expect(isReadHeld(MIDNIGHT + 1)).toBe(false);
  });

  it('resetAt null ends the hold and keeps used', async () => {
    await setReadHold({ resetAt: MIDNIGHT, used: 0.4 });
    await setReadHold({ resetAt: null });
    expect(isReadHeld()).toBe(false);
    expect(getReadHold()).toEqual({ resetAt: null, used: 0.4 });
  });

  it('clamps used to 0..1', async () => {
    await setReadHold({ used: 1.7 });
    expect(getReadHold().used).toBe(1);
    await setReadHold({ used: -2 });
    expect(getReadHold().used).toBe(0);
  });

  it('survives a reload through hydrate, and resetReadHold clears memory only', async () => {
    await setReadHold({ resetAt: MIDNIGHT, used: 1 });
    expect(mockStore.has(READ_HOLD_KEY)).toBe(true);
    resetReadHold();
    expect(isReadHeld()).toBe(false);
    await hydrateReadHold();
    expect(isReadHeld()).toBe(true);
    expect(getReadHold().used).toBe(1);
  });

  it('a write that arrives before hydrate keeps the stored hold', async () => {
    await setReadHold({ resetAt: MIDNIGHT, used: 1 });
    resetReadHold(); // a fresh process: memory empty, row kept, nothing hydrated yet
    await setReadHold({ used: 0.3 });
    expect(isReadHeld()).toBe(true);
    expect(getReadHold()).toEqual({ resetAt: MIDNIGHT, used: 0.3 });
  });

  it('hydrate never rejects on a bad row', async () => {
    mockStore.set(READ_HOLD_KEY, '{not json');
    await expect(hydrateReadHold()).resolves.toBeUndefined();
    expect(isReadHeld()).toBe(false);
  });
});
