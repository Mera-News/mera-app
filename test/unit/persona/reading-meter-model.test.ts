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

  it('cloud mode names the cloud', () => {
    expect(m().mode).toBe('cloud');
  });

  it('on device is unlimited: never held, never offline-only, no new-plan line', () => {
    expect(m({ onDevice: true })).toMatchObject({ mode: 'onDevice', done: false, showOfflineOnly: false });
    expect(m({ onDevice: true, held: true, used: 1 })).toMatchObject({ mode: 'onDevice', done: false });
    expect(m({ onDevice: true, online: false, used: null })).toMatchObject({ mode: 'onDevice', showOfflineOnly: false });
    expect(m({ onDevice: true, planRaised: true }).showNewPlan).toBe(false);
  });

  it('shows the new-plan line only when the plan rose', () => {
    expect(m({ planRaised: true }).showNewPlan).toBe(true);
    expect(m().showNewPlan).toBe(false);
  });
});
