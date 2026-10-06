const mockRows = new Map<string, string>();
const mockGetSetting = jest.fn(async (k: string) => mockRows.get(k) ?? null);
const mockSetSetting = jest.fn(async (k: string, v: string) => {
  mockRows.set(k, v);
});
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (k: string) => mockGetSetting(k),
  setSetting: (k: string, v: string) => mockSetSetting(k, v),
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

type Mod = typeof import('../hint-cursor');

/** A fresh JS context: module memory gone, the settings row kept. */
function newSession(): Mod {
  let mod!: Mod;
  jest.isolateModules(() => {
    mod = require('../hint-cursor');
  });
  return mod;
}

const row = () => JSON.parse(mockRows.get('nav_hint_cursor') ?? '{}');

beforeEach(() => {
  mockRows.clear();
  jest.clearAllMocks();
});

describe('takeHintIndex', () => {
  it('shows the next hint each session and loops', async () => {
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) seen.push(await newSession().takeHintIndex('feed', 3));
    expect(seen).toEqual([0, 1, 2, 0]);
  });

  it('is stable within a session and advances the row once', async () => {
    const s = newSession();
    expect(await s.takeHintIndex('feed', 3)).toBe(0);
    expect(await s.takeHintIndex('feed', 3)).toBe(0);
    expect(mockSetSetting).toHaveBeenCalledTimes(1);
    expect(row()).toEqual({ feed: 1 });
  });

  // Invariant 9: a raw increment would be a visit counter.
  it('never stores a value at or above the pool length', async () => {
    for (let i = 0; i < 7; i++) {
      await newSession().takeHintIndex('library', 2);
      expect(row().library).toBeLessThan(2);
    }
  });

  it('keeps pools apart and serialises writes so none is lost', async () => {
    const s = newSession();
    await Promise.all([s.takeHintIndex('feed', 3), s.takeHintIndex('world', 3), s.takeHintIndex('stories', 2)]);
    expect(row()).toEqual({ feed: 1, world: 1, stories: 1 });
  });

  it('clamps when the pool shrinks within a session', async () => {
    mockRows.set('nav_hint_cursor', '{"checks":2}');
    const s = newSession();
    expect(await s.takeHintIndex('checks', 3)).toBe(2);
    expect(await s.takeHintIndex('checks', 2)).toBe(0);
  });

  it('reads a corrupt row as empty, and an empty pool as 0 without writing', async () => {
    mockRows.set('nav_hint_cursor', '{"feed":-1,"x":"y"}');
    const s = newSession();
    expect(await s.takeHintIndex('feed', 3)).toBe(0);
    mockSetSetting.mockClear();
    expect(await s.takeHintIndex('other', 0)).toBe(0);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('shows the first hint when storage fails, and keeps working after', async () => {
    mockGetSetting.mockRejectedValueOnce(new Error('db'));
    const s = newSession();
    expect(await s.takeHintIndex('feed', 3)).toBe(0);
    expect(await s.takeHintIndex('world', 3)).toBe(0);
    expect(row()).toEqual({ world: 1 });
  });
});
