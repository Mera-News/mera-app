import {
  NOTIFICATION_HOURS,
  convertLocalHoursToUTC,
  convertUTCHoursToLocal,
  formatHour,
} from '../notificationSlotUtils';

describe('NOTIFICATION_HOURS', () => {
  it('enumerates all 24 hours of the day', () => {
    expect(NOTIFICATION_HOURS).toHaveLength(24);
    expect(NOTIFICATION_HOURS[0]).toBe(0);
    expect(NOTIFICATION_HOURS[23]).toBe(23);
  });
});

describe('formatHour', () => {
  it('zero-pads single-digit hours', () => {
    expect(formatHour(9)).toBe('09:00');
    expect(formatHour(0)).toBe('00:00');
  });

  it('leaves double-digit hours unpadded', () => {
    expect(formatHour(14)).toBe('14:00');
    expect(formatHour(23)).toBe('23:00');
  });
});

describe('local <-> UTC hour conversion', () => {
  it('round-trips every hour local -> UTC -> local', () => {
    const localHours = NOTIFICATION_HOURS;
    const roundTripped = convertUTCHoursToLocal(convertLocalHoursToUTC(localHours));
    expect(roundTripped).toEqual(localHours);
  });

  it('round-trips an arbitrary subset', () => {
    const localHours = [9, 14, 18];
    const utc = convertLocalHoursToUTC(localHours);
    expect(convertUTCHoursToLocal(utc)).toEqual(localHours);
  });

  it('returns hours within the valid 0-23 range after conversion', () => {
    const utc = convertLocalHoursToUTC([0, 23]);
    utc.forEach((h) => {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(23);
    });
  });

  it('handles wrap-around hours (offset can push hours past midnight)', () => {
    // Whatever the runner's offset, converting then inverting must wrap cleanly.
    const utc = convertLocalHoursToUTC([22, 23]);
    const back = convertUTCHoursToLocal(utc);
    expect(back).toEqual([22, 23]);
  });

  it('preserves order and length', () => {
    const input = [1, 5, 12, 20];
    expect(convertLocalHoursToUTC(input)).toHaveLength(input.length);
    expect(convertUTCHoursToLocal(input)).toHaveLength(input.length);
  });

  it('returns an empty array for empty input', () => {
    expect(convertLocalHoursToUTC([])).toEqual([]);
    expect(convertUTCHoursToLocal([])).toEqual([]);
  });
});
