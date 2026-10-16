import {
  readingMeterModel,
  type ReadingMeterInput,
} from '@/components/custom/config-mera/reading-meter-model';

// Local noon, so "today" and "tomorrow" cannot flip with the runner's time zone.
const NOON = new Date(2026, 5, 10, 12, 0, 0).getTime();
const base: ReadingMeterInput = {
  used: 0.3,
  held: false,
  holdResetAt: null,
  now: NOON,
  online: true,
  updatedAt: null,
  onDevice: false,
  onDeviceSupported: false,
  multiplier: 1,
  planRaised: false,
};
const m = (o: Partial<ReadingMeterInput> = {}) => readingMeterModel({ ...base, ...o });

describe('readingMeterModel', () => {
  it('is done at 100 percent while held, whatever used says', () => {
    expect(m({ held: true, used: 0.2 })).toMatchObject({ done: true, percent: 100 });
  });

  it('is done when used reaches 1', () => {
    expect(m({ used: 1 })).toMatchObject({ done: true, percent: 100 });
  });

  it('rounds the percent', () => {
    expect(m({ used: 0.426 }).percent).toBe(43);
    expect(m({ used: 0.004 }).percent).toBe(0);
  });

  it('online with nothing known reads 0', () => {
    expect(m({ used: null })).toMatchObject({ percent: 0, showOfflineOnly: false });
  });

  it('resets today when local midnight UTC is on the same local date, else tomorrow', () => {
    const held = m({ held: true, holdResetAt: NOON + 60_000 });
    expect(held.resetAt).toBe(NOON + 60_000);
    expect(held.resetDay).toBe('today');
    expect(m({ held: true, holdResetAt: NOON + 36 * 3_600_000 }).resetDay).toBe('tomorrow');
    expect(m().resetAt).toBeGreaterThan(NOON);
  });

  it('offline with a known used shows it with the last update', () => {
    expect(m({ online: false, used: 0.5, updatedAt: 123 })).toMatchObject({
      percent: 50,
      lastUpdatedAt: 123,
      showOfflineOnly: false,
    });
    expect(m({ online: true, updatedAt: 123 }).lastUpdatedAt).toBeNull();
  });

  it('offline with nothing known shows only the offline line', () => {
    expect(m({ online: false, used: null })).toMatchObject({ percent: null, showOfflineOnly: true });
  });

  it('offline but held is still known', () => {
    expect(m({ online: false, used: null, held: true, holdResetAt: NOON + 1 }).showOfflineOnly).toBe(false);
  });

  it('on-device dims and says so; support shows the unlimited line', () => {
    expect(m({ onDevice: true })).toMatchObject({ dimmed: true, showOnPhoneLine: true });
    expect(m()).toMatchObject({ dimmed: false, showOnPhoneLine: false, showUnlimitedLine: false });
    expect(m({ onDeviceSupported: true }).showUnlimitedLine).toBe(true);
  });

  it('states each plan in MB: 10 x the multiplier, Starter (and anything below) at 10', () => {
    expect(m({ multiplier: 1 })).toMatchObject({ multiplierKey: 'base', planMb: 10, multiplier: 1 });
    expect(m({ multiplier: 5 })).toMatchObject({ multiplierKey: 'n', planMb: 50, multiplier: 5 });
    expect(m({ multiplier: 20 })).toMatchObject({ multiplierKey: 'n', planMb: 200, multiplier: 20 });
    expect(m({ multiplier: 0 })).toMatchObject({ multiplierKey: 'base', planMb: 10, multiplier: 1 });
  });

  it('multiplier key is base at 1 or less, n above', () => {
    expect(m({ multiplier: 1 }).multiplierKey).toBe('base');
    expect(m({ multiplier: 5 }).multiplierKey).toBe('n');
  });

  it('shows the new-plan line only when the plan rose', () => {
    expect(m({ planRaised: true }).showNewPlan).toBe(true);
    expect(m().showNewPlan).toBe(false);
  });
});
