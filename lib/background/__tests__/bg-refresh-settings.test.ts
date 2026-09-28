// The refresh's settings rows: the toggle (default ON), and turning it OFF
// actually unregistering the OS task rather than leaving a wake that returns
// early.

const mockSettings = new Map<string, string>();
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: jest.fn(async (k: string) => mockSettings.get(k) ?? null),
  setSetting: jest.fn(async (k: string, v: string) => { mockSettings.set(k, v); }),
}));

const mockSync = jest.fn(async () => {});
jest.mock('../background-task', () => ({
  syncBackgroundTaskRegistration: () => mockSync(),
}));

import {
  BG_REFRESH_ENABLED_KEY,
  LAST_DAILY_ARTICLE_LIMIT_KEY,
  isBgRefreshEnabled,
  readLastForegroundAt,
  recordForeground,
  rememberDailyArticleLimit,
  setBgRefreshEnabled,
} from '../bg-refresh-settings';

beforeEach(() => {
  mockSettings.clear();
  jest.clearAllMocks();
});

describe('the toggle', () => {
  it('is ON on a device that was never asked', async () => {
    expect(await isBgRefreshEnabled()).toBe(true);
  });

  it('reads OFF only when explicitly turned off', async () => {
    await setBgRefreshEnabled(false);
    expect(mockSettings.get(BG_REFRESH_ENABLED_KEY)).toBe('0');
    expect(await isBgRefreshEnabled()).toBe(false);
  });

  it('re-syncs the OS registration on every change, both ways', async () => {
    await setBgRefreshEnabled(false);
    await setBgRefreshEnabled(true);
    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(await isBgRefreshEnabled()).toBe(true);
  });

  it('keeps the saved choice even when the registration change fails', async () => {
    mockSync.mockRejectedValueOnce(new Error('denied'));
    await expect(setBgRefreshEnabled(false)).resolves.toBeUndefined();
    expect(await isBgRefreshEnabled()).toBe(false);
  });
});

describe('last foreground', () => {
  it('round-trips', async () => {
    expect(await readLastForegroundAt()).toBeNull();
    await recordForeground(1234);
    expect(await readLastForegroundAt()).toBe(1234);
  });
});

describe('the daily limit memory', () => {
  it('stores what entitlement-sync saw', async () => {
    await rememberDailyArticleLimit(1000);
    expect(mockSettings.get(LAST_DAILY_ARTICLE_LIMIT_KEY)).toBe('1000');
  });

  it('ignores anything that is not a usable number', async () => {
    await rememberDailyArticleLimit(undefined);
    await rememberDailyArticleLimit(Number.NaN);
    await rememberDailyArticleLimit(-1);
    expect(mockSettings.has(LAST_DAILY_ARTICLE_LIMIT_KEY)).toBe(false);
  });
});
