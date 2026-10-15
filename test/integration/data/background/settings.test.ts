// The small modules around the wake, on the in-memory DB: the refresh settings rows, the open-ready measure over real rows, the Background refresh row's helpers
// and the collect gate.
//
// Replaces lib/background/__tests__/background-allowance.test.ts, bg-refresh-settings.test.ts (rows;
// the toggle's re-sync is in registration.test.ts) and bg-refresh-ui.test.ts (its copy checks are
// in contracts/bg-refresh-copy.test.ts). Those mocked setting-service with a Map and the settings
// module; the rows are real here. open-ready-target.test.ts is NOT replaced: every function it tests
// is pure, so it stays where it is until P4 moves it with its subject.
jest.mock('expo-task-manager', () => require('./native-fakes').taskManagerModule);
jest.mock('expo-background-task', () => require('./native-fakes').backgroundTaskModule);

import {
  LAST_FOREGROUND_AT_KEY,
  parseFiniteNumber,
  readLastForegroundAt,
  recordForeground,
} from '@/lib/background/bg-refresh-settings';
import {
  bgRefreshDescriptionKey,
  loadBgRefreshToggle,
  saveBgRefreshToggle,
} from '@/lib/background/bg-refresh-ui';
import {
  isBackgroundCollectRunning,
  trackBackgroundCollect,
  waitForBackgroundCollect,
} from '@/lib/background/collect-gate';
import { measureOpenReadiness } from '@/lib/background/open-ready-target';
import { batchMarkExcluded } from '@/lib/database/services/article-suggestion-scoring-writes';
import { batchMarkAlreadyRead } from '@/lib/feed-grouping/read-story-filter';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { BG_REFRESH_ENABLED_KEY, isBgRefreshEnabled } from '@/lib/background/bg-refresh-settings';

import { registeredTasks, resetNativeTasks } from './native-fakes';
import { HOUR, NOW, failSettingRead, seedScored, seedUnscored, wakeCleanup, wakeWorld } from './support';

beforeEach(async () => {
  resetNativeTasks();
  await wakeWorld();
});
afterEach(wakeCleanup);

describe('the refresh settings rows', () => {
  it('the toggle is ON on a device that was never asked, and OFF only when it holds exactly "0"', async () => {
    expect(await isBgRefreshEnabled()).toBe(true);
    await setSetting(BG_REFRESH_ENABLED_KEY, '1');
    expect(await isBgRefreshEnabled()).toBe(true);
    await setSetting(BG_REFRESH_ENABLED_KEY, '0');
    expect(await isBgRefreshEnabled()).toBe(false);
  });

  it('last foreground round-trips as epoch milliseconds', async () => {
    await setSetting(LAST_FOREGROUND_AT_KEY, '');
    expect(await readLastForegroundAt()).toBeNull();

    await recordForeground(1234);

    expect(await readLastForegroundAt()).toBe(1234);
    expect(await getSetting(LAST_FOREGROUND_AT_KEY)).toBe('1234');
  });

  it('parses only finite numbers', () => {
    expect(parseFiniteNumber(null)).toBeNull();
    expect(parseFiniteNumber('')).toBeNull();
    expect(parseFiniteNumber('abc')).toBeNull();
    expect(parseFiniteNumber('Infinity')).toBeNull();
    expect(parseFiniteNumber('42')).toBe(42);
  });
});

describe('the open-ready measure over real rows', () => {
  it('counts relevant and pending rows inside the window, and leaves out excluded and already-read rows', async () => {
    await seedScored(3); // passes the gate, fresh
    await seedScored(2, { relevance: 0.1, prefix: 'low' }); // scored, below the gate
    await seedScored(2, { ageMs: 7 * HOUR, prefix: 'stale' }); // scored, passes, outside the window
    const waiting = await seedUnscored(4);
    await seedUnscored(1, { ageMs: 7 * HOUR, prefix: 'oldwait' }); // pending but outside the window
    const gone = await seedScored(2, { prefix: 'gone' });
    await batchMarkExcluded([gone[0]], NOW);
    await batchMarkAlreadyRead([gone[1]], NOW);

    const readiness = await measureOpenReadiness(NOW);

    expect(readiness).toEqual({
      relevant6h: 3,
      pending6h: waiting.length,
      yield: 0.33, // 7 scored rows: fewer than 20, so the default
      yieldSample: 7,
    });
  });

  it('measures the device pass ratio from 20 scored rows on', async () => {
    await seedScored(15);
    await seedScored(5, { relevance: 0.1, prefix: 'low' });

    expect(await measureOpenReadiness(NOW)).toMatchObject({ yield: 0.75, yieldSample: 20 });
  });

  it('floors the yield, so a device whose rows all missed the gate cannot ask for an unbounded fetch', async () => {
    await seedScored(25, { relevance: 0.1 });

    expect((await measureOpenReadiness(NOW)).yield).toBe(0.05);
  });
});

describe('the Background refresh row', () => {
  it('chooses the description by what the run will do', () => {
    expect(bgRefreshDescriptionKey(false, 'ios')).toBe('meraProtocol.bgRefreshCloudIos');
    expect(bgRefreshDescriptionKey(false, 'android')).toBe('meraProtocol.bgRefreshCloudAndroid');
    expect(bgRefreshDescriptionKey(true, 'ios')).toBe('meraProtocol.bgRefreshOnDevice');
    expect(bgRefreshDescriptionKey(true, 'android')).toBe('meraProtocol.bgRefreshOnDevice');
  });

  it('reads the stored toggle, and ON (its default) when the setting cannot be read', async () => {
    await setSetting(BG_REFRESH_ENABLED_KEY, '0');
    expect(await loadBgRefreshToggle()).toBe(false);

    failSettingRead(BG_REFRESH_ENABLED_KEY);
    expect(await loadBgRefreshToggle()).toBe(true);
  });

  it('saves the toggle and re-syncs the OS task', async () => {
    await saveBgRefreshToggle(true);
    expect(registeredTasks()).toHaveLength(1);

    await saveBgRefreshToggle(false);

    expect(await getSetting(BG_REFRESH_ENABLED_KEY)).toBe('0');
    expect(registeredTasks()).toEqual([]);
  });
});

describe('the collect gate', () => {
  const never = () => new Promise<void>(() => undefined);

  it('answers "is a collect running" from track until the work settles', async () => {
    let finish!: () => void;
    const work = trackBackgroundCollect(new Promise<string>((resolve) => (finish = () => resolve('collected'))));
    expect(isBackgroundCollectRunning()).toBe(true);

    finish();

    await expect(work).resolves.toBe('collected');
    await Promise.resolve();
    expect(isBackgroundCollectRunning()).toBe(false);
  });

  it('hands a failing collect back to its caller, but the gate itself never rejects', async () => {
    const failing = trackBackgroundCollect(Promise.reject(new Error('collect died')));

    await expect(failing).rejects.toThrow('collect died');
    await expect(waitForBackgroundCollect(1000)).resolves.toBeUndefined();
    expect(isBackgroundCollectRunning()).toBe(false);
  });

  it('resolves at once when nothing is running', async () => {
    await expect(waitForBackgroundCollect(20_000)).resolves.toBeUndefined();
  });

  it('waits for the collect to finish, then resolves', async () => {
    let finish!: () => void;
    void trackBackgroundCollect(new Promise<void>((resolve) => (finish = resolve)));
    let waited = false;
    void waitForBackgroundCollect(20_000).then(() => (waited = true));

    await jest.advanceTimersByTimeAsync(1_000);
    expect(waited).toBe(false);
    finish();
    await jest.advanceTimersByTimeAsync(0);

    expect(waited).toBe(true);
  });

  it('keeps answering "running" while a later collect is going, when an earlier one settles first', async () => {
    let first!: () => void;
    void trackBackgroundCollect(new Promise<void>((resolve) => (first = resolve)));
    let second!: () => void;
    void trackBackgroundCollect(new Promise<void>((resolve) => (second = resolve)));

    first();
    await jest.advanceTimersByTimeAsync(0);
    expect(isBackgroundCollectRunning()).toBe(true);

    second();
    await jest.advanceTimersByTimeAsync(0);
    expect(isBackgroundCollectRunning()).toBe(false);
  });

  it('gives up at the cap when the collect is still going', async () => {
    void trackBackgroundCollect(never());
    let waited = false;
    void waitForBackgroundCollect(20_000).then(() => (waited = true));

    await jest.advanceTimersByTimeAsync(19_999);
    expect(waited).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    expect(waited).toBe(true);
    expect(isBackgroundCollectRunning()).toBe(true); // the gate gives up waiting; the collect goes on
  });
});
