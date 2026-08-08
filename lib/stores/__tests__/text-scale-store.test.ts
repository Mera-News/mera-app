// Mock DB services and logger BEFORE any import — the store reaches the
// settings table, which instantiates the WatermelonDB SQLite adapter at module
// scope.
const mockGetSetting = jest.fn((_key: string): Promise<string | null> => Promise.resolve(null));
const mockSetSetting = jest.fn((_key: string, _value: string) => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (key: string) => mockGetSetting(key),
  setSetting: (key: string, value: string) => mockSetSetting(key, value),
  deleteSetting: jest.fn(() => Promise.resolve()),
}));

const mockCaptureException = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: (...args: unknown[]) => mockCaptureException(...args),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

import { DEFAULT_TEXT_SCALE } from '@/lib/typography/scale';
import { useTextScaleStore } from '../text-scale-store';

describe('useTextScaleStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useTextScaleStore.setState({ scale: DEFAULT_TEXT_SCALE, hydrated: false });
  });

  it('starts at the designed size, unhydrated', () => {
    expect(useTextScaleStore.getState().scale).toBe(1);
    expect(useTextScaleStore.getState().hydrated).toBe(false);
  });

  it('reads the correct setting key', async () => {
    await useTextScaleStore.getState().hydrate();
    expect(mockGetSetting).toHaveBeenCalledWith('text_scale');
  });

  it('hydrates a stored step', async () => {
    mockGetSetting.mockResolvedValueOnce('1.3');
    await useTextScaleStore.getState().hydrate();
    expect(useTextScaleStore.getState().scale).toBe(1.3);
    expect(useTextScaleStore.getState().hydrated).toBe(true);
  });

  // No row means the user has never chosen — that must render the DESIGNED
  // size, not something derived.
  it('leaves the scale at 1 when nothing is stored', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    await useTextScaleStore.getState().hydrate();
    expect(useTextScaleStore.getState().scale).toBe(1);
  });

  it('snaps a stored value that is no longer a step', async () => {
    mockGetSetting.mockResolvedValueOnce('1.22');
    await useTextScaleStore.getState().hydrate();
    expect(useTextScaleStore.getState().scale).toBe(1.15);
  });

  it('falls back to the default for unparseable stored text', async () => {
    mockGetSetting.mockResolvedValueOnce('enormous');
    await useTextScaleStore.getState().hydrate();
    expect(useTextScaleStore.getState().scale).toBe(1);
  });

  it('still marks hydrated and reports when getSetting throws', async () => {
    const err = new Error('db crash');
    mockGetSetting.mockRejectedValueOnce(err);
    await expect(useTextScaleStore.getState().hydrate()).resolves.toBeUndefined();
    expect(useTextScaleStore.getState().hydrated).toBe(true);
    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: { store: 'text-scale-store' } }),
    );
  });

  it('applies and persists a new step', async () => {
    useTextScaleStore.getState().setScale(1.5);
    expect(useTextScaleStore.getState().scale).toBe(1.5);
    await Promise.resolve();
    expect(mockSetSetting).toHaveBeenCalledWith('text_scale', '1.5');
  });

  it('reports a failed write without throwing', async () => {
    const err = new Error('persist fail');
    mockSetSetting.mockRejectedValueOnce(err);
    useTextScaleStore.getState().setScale(0.9);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: { store: 'text-scale-store' } }),
    );
  });
});
