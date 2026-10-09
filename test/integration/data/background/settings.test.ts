// The small modules around the wake, on the in-memory DB: the allowance ledger read and write, the
// refresh settings rows, the open-ready measure over real rows, the Background refresh row's helpers
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
  BG_RUN_METERED_CAP,
  STARTER_FALLBACK_DAILY_LIMIT,
  adjustCharged,
  markQuotaExhausted,
  readAllowance,
  reserveCharged,
  settleCharged,
  utcDayKey,
} from '@/lib/background/background-allowance';
import {
  BG_ARTICLES_CHARGED_PREFIX,
  BG_QUOTA_EXHAUSTED_DAY_KEY,
  LAST_DAILY_ARTICLE_LIMIT_KEY,
  LAST_FOREGROUND_AT_KEY,
  parseFiniteNumber,
  readLastForegroundAt,
  recordForeground,
  rememberDailyArticleLimit,
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
import { batchMarkExcluded } from '@/lib/database/services/article-suggestion-service';
import { batchMarkAlreadyRead } from '@/lib/feed-grouping/read-story-filter';
import { getSetting, getSettingsByPrefix, setSetting } from '@/lib/database/services/setting-service';
import { BG_REFRESH_ENABLED_KEY, isBgRefreshEnabled } from '@/lib/background/bg-refresh-settings';

import { registeredTasks, resetNativeTasks } from './native-fakes';
import { HOUR, NOW, failBatchWhere, failSettingRead, seedScored, seedUnscored, wakeCleanup, wakeWorld } from './support';

beforeEach(async () => {
  resetNativeTasks();
  await wakeWorld();
});
afterEach(wakeCleanup);

const NOON = Date.UTC(2026, 8, 28, 12, 0, 0);

describe('the per-run and per-day caps', () => {
  it('assumes Starter (250, so 125 a day) when entitlement-sync never answered', async () => {
    const a = await readAllowance(NOON);

    expect(STARTER_FALLBACK_DAILY_LIMIT).toBe(250);
    expect(a).toEqual({ perRun: BG_RUN_METERED_CAP, dayCap: 125, chargedToday: 0, exhausted: false });
  });

  it('caps a day at HALF the last known limit, and a run at 50 however large the limit', async () => {
    await rememberDailyArticleLimit(1000);
    expect((await readAllowance(NOON)).dayCap).toBe(500);

    await rememberDailyArticleLimit(10_000);
    expect((await readAllowance(NOON)).perRun).toBe(50);
  });

  it('shrinks the run to what is left of the day, and is zero once the day cap is spent', async () => {
    await reserveCharged(NOON, 100);
    expect(await readAllowance(NOON)).toMatchObject({ chargedToday: 100, perRun: 25 });

    await reserveCharged(NOON, 25);
    expect((await readAllowance(NOON)).perRun).toBe(0);
  });

  it('is zero for the rest of the UTC day once the server reported the cap', async () => {
    await markQuotaExhausted(NOON);

    const a = await readAllowance(NOON + 60_000);

    expect(a).toMatchObject({ exhausted: true, perRun: 0 });
    expect(await getSetting(BG_QUOTA_EXHAUSTED_DAY_KEY)).toBe('2026-09-28');
  });

  it('starts a fresh day at 00:00 UTC, for both the ledger and the exhausted flag', async () => {
    await reserveCharged(NOON, 125);
    await markQuotaExhausted(NOON);

    const a = await readAllowance(Date.UTC(2026, 8, 29, 0, 0, 1));

    expect(a).toMatchObject({ chargedToday: 0, exhausted: false, perRun: 50 });
    expect(utcDayKey(Date.UTC(2026, 8, 28, 23, 59, 59))).toBe('2026-09-28');
    expect(utcDayKey(Date.UTC(2026, 8, 29, 0, 0, 0))).toBe('2026-09-29');
  });

  it('keeps one ledger row: a new day deletes the old ones', async () => {
    await reserveCharged(NOON, 10);
    await reserveCharged(Date.UTC(2026, 8, 29, 1), 5);

    expect(await getSettingsByPrefix(BG_ARTICLES_CHARGED_PREFIX)).toEqual({
      [`${BG_ARTICLES_CHARGED_PREFIX}2026-09-29`]: '5',
    });
  });

  it('reads a damaged ledger or limit row as the defaults rather than failing', async () => {
    await setSetting(LAST_DAILY_ARTICLE_LIMIT_KEY, 'lots');
    await setSetting(`${BG_ARTICLES_CHARGED_PREFIX}2026-09-28`, '-40');

    expect(await readAllowance(NOON)).toMatchObject({ dayCap: 125, chargedToday: 0 });
  });
});

describe('reserve before, correct after', () => {
  const charged = async () => (await readAllowance(NOON)).chargedToday;

  it('a kill after the reservation, before any answer, leaves the reservation in the ledger', async () => {
    await reserveCharged(NOON, 25);

    expect(await charged()).toBe(25);
  });

  it('a partial grant corrects the ledger down to the grant; a full grant keeps the reservation', async () => {
    await reserveCharged(NOON, 25);
    await settleCharged(NOON, 25, 10);
    expect(await charged()).toBe(10);

    await reserveCharged(NOON, 25);
    await settleCharged(NOON, 25, 25);
    expect(await charged()).toBe(35);
  });

  it('sums reservations across requests and runs', async () => {
    await reserveCharged(NOON, 20);
    await settleCharged(NOON, 20, 20);
    await reserveCharged(NOON, 7);

    expect(await charged()).toBe(27);
  });

  it('never goes below zero, and ignores a fraction or a negative reservation', async () => {
    await settleCharged(NOON, 25, 0);
    expect(await charged()).toBe(0);

    await reserveCharged(NOON, -5);
    await adjustCharged(NOON, 7.9);
    expect(await charged()).toBe(7);
  });

  it('a run that crosses midnight corrects the row it reserved (the run keeps one day key)', async () => {
    await reserveCharged(NOON, 25);
    await settleCharged(NOON, 25, 5);

    expect(await getSetting(`${BG_ARTICLES_CHARGED_PREFIX}${utcDayKey(NOON)}`)).toBe('5');
  });
});

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

  it('remembers what entitlement-sync saw, floored, and ignores anything that is not a usable number', async () => {
    await rememberDailyArticleLimit(1000.9);
    expect(await getSetting(LAST_DAILY_ARTICLE_LIMIT_KEY)).toBe('1000');

    await setSetting(LAST_DAILY_ARTICLE_LIMIT_KEY, '300');
    for (const bad of [undefined, null, 'x', Number.NaN, Infinity, -1]) await rememberDailyArticleLimit(bad);
    expect(await getSetting(LAST_DAILY_ARTICLE_LIMIT_KEY)).toBe('300');
  });

  it('a limit that cannot be saved is not an error: the allowance falls back to Starter', async () => {
    failBatchWhere((op) => op.table === 'settings' && op.raw?.key === LAST_DAILY_ARTICLE_LIMIT_KEY);

    await expect(rememberDailyArticleLimit(40)).resolves.toBeUndefined();

    expect((await readAllowance(NOW)).dayCap).toBe(125);
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
