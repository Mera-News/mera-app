const mockSettings = new Map<string, string>();
let mockReadFails = false;
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: async (k: string) => {
    if (mockReadFails) throw new Error('db');
    return mockSettings.get(k) ?? null;
  },
  setSetting: async (k: string, v: string) => {
    mockSettings.set(k, v);
  },
}));

import {
  cornerPoint,
  hydrateMeraButtonCorner,
  MERA_BUTTON_CORNER_KEY,
  nearestCorner,
  resetMeraButtonCorner,
  setMeraCorner,
  tooltipSide,
  useMeraCornerStore,
} from '../corner';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('nearestCorner', () => {
  it.each([
    [10, 10, 'tl'],
    [380, 10, 'tr'],
    [10, 790, 'bl'],
    [380, 790, 'br'],
    [194, 399, 'tl'],
    // Exactly on a midline: right and bottom, today's spot.
    [195, 400, 'br'],
    [195, 10, 'tr'],
    [10, 400, 'bl'],
    // Thrown past an edge: clamps by quadrant.
    [-500, -500, 'tl'],
    [5000, -20, 'tr'],
    [-3, 5000, 'bl'],
    [9999, 9999, 'br'],
  ] as const)('(%s, %s) -> %s on a 390 x 800 area', (x, y, corner) => {
    expect(nearestCorner(x, y, 390, 800)).toBe(corner);
  });
});

describe('cornerPoint', () => {
  const frame = { width: 390, height: 800, top: 118, bottom: 98, inset: 14, size: 62 };
  it.each([
    ['tl', 14, 118],
    ['tr', 314, 118],
    ['bl', 14, 640],
    ['br', 314, 640],
  ] as const)('%s sits at (%s, %s)', (corner, x, y) => {
    expect(cornerPoint(corner, frame)).toEqual({ x, y });
  });
});

it('the tooltip faces the middle', () => {
  expect(tooltipSide('tl')).toBe('right');
  expect(tooltipSide('bl')).toBe('right');
  expect(tooltipSide('tr')).toBe('left');
  expect(tooltipSide('br')).toBe('left');
});

describe('persistence', () => {
  beforeEach(() => {
    mockSettings.clear();
    mockReadFails = false;
    resetMeraButtonCorner();
  });

  it('round-trips: a set corner is what the next launch reads', async () => {
    setMeraCorner('tr');
    await flush();
    expect(mockSettings.get(MERA_BUTTON_CORNER_KEY)).toBe('tr');
    resetMeraButtonCorner(); // a fresh JS context
    mockSettings.set(MERA_BUTTON_CORNER_KEY, 'tr');
    expect(useMeraCornerStore.getState()).toMatchObject({ corner: 'br', hydrated: false });
    await hydrateMeraButtonCorner();
    expect(useMeraCornerStore.getState()).toMatchObject({ corner: 'tr', hydrated: true });
  });

  it('a garbage stored value reads as bottom right', async () => {
    mockSettings.set(MERA_BUTTON_CORNER_KEY, 'middle');
    await hydrateMeraButtonCorner();
    expect(useMeraCornerStore.getState()).toMatchObject({ corner: 'br', hydrated: true });
  });

  it('a failed read still hydrates, at bottom right', async () => {
    mockReadFails = true;
    await hydrateMeraButtonCorner();
    expect(useMeraCornerStore.getState()).toMatchObject({ corner: 'br', hydrated: true });
  });

  it('hydrates once per JS context', async () => {
    mockSettings.set(MERA_BUTTON_CORNER_KEY, 'bl');
    await hydrateMeraButtonCorner();
    mockSettings.set(MERA_BUTTON_CORNER_KEY, 'tl');
    await hydrateMeraButtonCorner();
    expect(useMeraCornerStore.getState().corner).toBe('bl');
  });

  it('reset (account switch) goes back to bottom right, unhydrated', async () => {
    setMeraCorner('tl');
    resetMeraButtonCorner();
    expect(useMeraCornerStore.getState()).toMatchObject({ corner: 'br', hydrated: false });
  });
});
