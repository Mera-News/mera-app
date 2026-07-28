import {
  DASHBOARD_RESORT_INTERVAL_MINUTES,
  DASHBOARD_RESORT_INTERVAL_MS,
  msUntilResortDue,
  shouldResort,
} from '../dashboard-resort';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

describe('DASHBOARD_RESORT_INTERVAL', () => {
  it('is 30 minutes, in both units', () => {
    expect(DASHBOARD_RESORT_INTERVAL_MINUTES).toBe(30);
    expect(DASHBOARD_RESORT_INTERVAL_MS).toBe(30 * MIN);
  });
});

describe('shouldResort', () => {
  it('always seeds the first snapshot', () => {
    expect(shouldResort({ lastAppliedMs: null, nowMs: T0, trigger: 'unwatched' })).toBe(true);
    expect(shouldResort({ lastAppliedMs: null, nowMs: T0, trigger: 'elapsed' })).toBe(true);
  });

  // The whole point: a user flicking between tabs must not reshuffle the list.
  it('refuses before the interval, even when the user looks away', () => {
    expect(
      shouldResort({ lastAppliedMs: T0, nowMs: T0 + 29 * MIN, trigger: 'unwatched' }),
    ).toBe(false);
  });

  it('refuses before the interval on the elapsed trigger too', () => {
    expect(shouldResort({ lastAppliedMs: T0, nowMs: T0 + 1 * MIN, trigger: 'elapsed' })).toBe(false);
  });

  it('allows exactly at the mark', () => {
    expect(
      shouldResort({ lastAppliedMs: T0, nowMs: T0 + 30 * MIN, trigger: 'unwatched' }),
    ).toBe(true);
  });

  // A user who never looks away still gets a converging order.
  it('allows past the interval while still watching', () => {
    expect(shouldResort({ lastAppliedMs: T0, nowMs: T0 + 45 * MIN, trigger: 'elapsed' })).toBe(true);
  });

  it('honours an injected interval', () => {
    expect(
      shouldResort({ lastAppliedMs: T0, nowMs: T0 + 5 * MIN, trigger: 'elapsed', intervalMs: MIN }),
    ).toBe(true);
  });
});

describe('msUntilResortDue', () => {
  it('is 0 when nothing has been applied yet', () => {
    expect(msUntilResortDue(null, T0)).toBe(0);
  });

  it('counts down to the mark', () => {
    expect(msUntilResortDue(T0, T0 + 10 * MIN)).toBe(20 * MIN);
  });

  it('never goes negative', () => {
    expect(msUntilResortDue(T0, T0 + 90 * MIN)).toBe(0);
  });
});
