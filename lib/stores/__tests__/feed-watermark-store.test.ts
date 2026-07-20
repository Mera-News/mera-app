// feed-watermark-store — hydrate (KV read, missing→0, no-downgrade), monotonic
// advance, and write-through. The settings KV service is mocked so importing the
// store never touches a real WatermelonDB.

const mockGetSetting = jest.fn((_key: string): Promise<string | null> => Promise.resolve(null));
const mockSetSetting = jest.fn((_key: string, _value: string) => Promise.resolve());
const mockDeleteSetting = jest.fn((_key: string) => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (key: string) => mockGetSetting(key),
  setSetting: (key: string, value: string) => mockSetSetting(key, value),
  deleteSetting: (key: string) => mockDeleteSetting(key),
}));

const mockCapture = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: (...a: unknown[]) => mockCapture(...a),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import { useFeedWatermarkStore, FEED_WATERMARK_SETTING_KEY } from '../feed-watermark-store';

const flush = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  useFeedWatermarkStore.setState({ watermarkMs: null });
  mockGetSetting.mockResolvedValue(null);
  mockSetSetting.mockResolvedValue(undefined);
});

describe('feed-watermark-store hydrate', () => {
  it('starts unhydrated (watermarkMs null)', () => {
    expect(useFeedWatermarkStore.getState().watermarkMs).toBeNull();
  });

  it('reads the persisted value from the KV', async () => {
    mockGetSetting.mockResolvedValueOnce('1700000000000');
    await useFeedWatermarkStore.getState().hydrate();
    expect(mockGetSetting).toHaveBeenCalledWith(FEED_WATERMARK_SETTING_KEY);
    expect(useFeedWatermarkStore.getState().watermarkMs).toBe(1700000000000);
  });

  it('defaults to 0 when the KV is missing', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    await useFeedWatermarkStore.getState().hydrate();
    expect(useFeedWatermarkStore.getState().watermarkMs).toBe(0);
  });

  it('defaults to 0 on a non-numeric KV value', async () => {
    mockGetSetting.mockResolvedValueOnce('garbage');
    await useFeedWatermarkStore.getState().hydrate();
    expect(useFeedWatermarkStore.getState().watermarkMs).toBe(0);
  });

  it('never downgrades an in-memory value advanced before hydrate resolves', async () => {
    // advance() ran first (in-memory 500), disk has 200 → keep the newer 500.
    useFeedWatermarkStore.setState({ watermarkMs: 500 });
    mockGetSetting.mockResolvedValueOnce('200');
    await useFeedWatermarkStore.getState().hydrate();
    expect(useFeedWatermarkStore.getState().watermarkMs).toBe(500);
  });

  it('adopts a newer disk value over an older in-memory one', async () => {
    useFeedWatermarkStore.setState({ watermarkMs: 100 });
    mockGetSetting.mockResolvedValueOnce('900');
    await useFeedWatermarkStore.getState().hydrate();
    expect(useFeedWatermarkStore.getState().watermarkMs).toBe(900);
  });

  it('falls open to 0 when the KV read throws', async () => {
    mockGetSetting.mockRejectedValueOnce(new Error('db error'));
    await useFeedWatermarkStore.getState().hydrate();
    expect(useFeedWatermarkStore.getState().watermarkMs).toBe(0);
    expect(mockCapture).toHaveBeenCalled();
  });
});

describe('feed-watermark-store advance', () => {
  it('moves forward and writes through to the KV', async () => {
    useFeedWatermarkStore.setState({ watermarkMs: 100 });
    useFeedWatermarkStore.getState().advance(500);
    expect(useFeedWatermarkStore.getState().watermarkMs).toBe(500);
    await flush();
    expect(mockSetSetting).toHaveBeenCalledWith(FEED_WATERMARK_SETTING_KEY, '500');
  });

  it('is a no-op (no write) for an equal or lower candidate', async () => {
    useFeedWatermarkStore.setState({ watermarkMs: 500 });
    useFeedWatermarkStore.getState().advance(500);
    useFeedWatermarkStore.getState().advance(200);
    expect(useFeedWatermarkStore.getState().watermarkMs).toBe(500);
    await flush();
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('treats an unhydrated (null) value as 0', async () => {
    // watermarkMs null → baseline 0 → advance(1) applies.
    useFeedWatermarkStore.getState().advance(1);
    expect(useFeedWatermarkStore.getState().watermarkMs).toBe(1);
    await flush();
    expect(mockSetSetting).toHaveBeenCalledWith(FEED_WATERMARK_SETTING_KEY, '1');
  });

  it('ignores a non-finite candidate', () => {
    useFeedWatermarkStore.setState({ watermarkMs: 100 });
    useFeedWatermarkStore.getState().advance(Number.NaN);
    expect(useFeedWatermarkStore.getState().watermarkMs).toBe(100);
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('swallows a write-through failure', async () => {
    mockSetSetting.mockRejectedValueOnce(new Error('storage error'));
    useFeedWatermarkStore.setState({ watermarkMs: 0 });
    useFeedWatermarkStore.getState().advance(10);
    expect(useFeedWatermarkStore.getState().watermarkMs).toBe(10);
    await flush();
    expect(mockCapture).toHaveBeenCalled();
  });
});
