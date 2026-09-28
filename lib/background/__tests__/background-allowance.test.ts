// The background article allowance: at most 50 metered per run, at most half
// the daily limit per UTC day, closed for the day once the server says the
// cap was reached. All local, from settings rows.

const mockSettings = new Map<string, string>();
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: jest.fn(async (k: string) => mockSettings.get(k) ?? null),
  setSetting: jest.fn(async (k: string, v: string) => { mockSettings.set(k, v); }),
  deleteSetting: jest.fn(async (k: string) => { mockSettings.delete(k); }),
  getSettingsByPrefix: jest.fn(async (p: string) => {
    const out: Record<string, string> = {};
    for (const [k, v] of mockSettings) if (k.startsWith(p)) out[k] = v;
    return out;
  }),
}));

import {
  BG_RUN_METERED_CAP,
  markQuotaExhausted,
  readAllowance,
  recordCharged,
  utcDayKey,
} from '../background-allowance';

const NOON = Date.UTC(2026, 8, 28, 12, 0, 0);

beforeEach(() => mockSettings.clear());

describe('the per-run and per-day caps', () => {
  it('assumes Starter (250, so 125 a day) when entitlement-sync never answered', async () => {
    const a = await readAllowance(NOON);
    expect(a.dayCap).toBe(125);
    expect(a.perRun).toBe(BG_RUN_METERED_CAP);
  });

  it('caps a day at HALF the last known limit', async () => {
    mockSettings.set('last_daily_article_limit', '1000');
    expect((await readAllowance(NOON)).dayCap).toBe(500);
  });

  it('never gives one run more than 50, however large the limit', async () => {
    mockSettings.set('last_daily_article_limit', '10000');
    expect((await readAllowance(NOON)).perRun).toBe(50);
  });

  it('shrinks the run to what is left of the day', async () => {
    await recordCharged(NOON, 100);
    const a = await readAllowance(NOON);
    expect(a.chargedToday).toBe(100);
    expect(a.perRun).toBe(25);
  });

  it('is zero once the day cap is spent', async () => {
    await recordCharged(NOON, 125);
    expect((await readAllowance(NOON)).perRun).toBe(0);
  });

  it('is zero for the rest of the UTC day once the server reported the cap', async () => {
    await markQuotaExhausted(NOON);
    const a = await readAllowance(NOON + 60_000);
    expect(a.exhausted).toBe(true);
    expect(a.perRun).toBe(0);
  });
});

describe('the UTC day rollover', () => {
  it('starts a fresh day at 00:00 UTC, for both the ledger and the exhausted flag', async () => {
    await recordCharged(NOON, 125);
    await markQuotaExhausted(NOON);
    const nextDay = Date.UTC(2026, 8, 29, 0, 0, 1);
    const a = await readAllowance(nextDay);
    expect(a.chargedToday).toBe(0);
    expect(a.exhausted).toBe(false);
    expect(a.perRun).toBe(50);
  });

  it('keeps one ledger row: a new day deletes the old ones', async () => {
    await recordCharged(NOON, 10);
    await recordCharged(Date.UTC(2026, 8, 29, 1), 5);
    const keys = [...mockSettings.keys()].filter((k) => k.startsWith('bg_articles_charged:'));
    expect(keys).toEqual([`bg_articles_charged:${utcDayKey(Date.UTC(2026, 8, 29, 1))}`]);
  });

  it('adds what the server granted, not what was asked for', async () => {
    await recordCharged(NOON, 20);
    await recordCharged(NOON, 7);
    expect((await readAllowance(NOON)).chargedToday).toBe(27);
  });
});
