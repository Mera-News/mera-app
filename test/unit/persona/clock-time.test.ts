const mockCalendars = jest.fn();
jest.mock('expo-localization', () => ({ getCalendars: () => mockCalendars() }));

import { deviceHour12, formatClockTime } from '@/lib/subscription/clock-time';

// 19:30 local, whatever the test machine's zone.
const AT = new Date(2026, 9, 15, 19, 30).getTime();

describe('formatClockTime', () => {
  it('a 24h phone reads 24h even in English', () => {
    mockCalendars.mockReturnValue([{ uses24hourClock: true }]);
    const s = formatClockTime(AT, 'en')!;
    expect(s).toMatch(/19:30/);
    expect(s).not.toMatch(/PM/i);
  });

  it('a 12h phone reads 12h even in German', () => {
    mockCalendars.mockReturnValue([{ uses24hourClock: false }]);
    const s = formatClockTime(AT, 'de')!;
    expect(s).toMatch(/7:30/);
    expect(s).not.toMatch(/19:30/);
  });

  it('an unknown calendar falls back to the language default', () => {
    mockCalendars.mockReturnValue([]);
    expect(deviceHour12()).toBeUndefined();
    expect(formatClockTime(AT, 'de')).toMatch(/19:30/);
    mockCalendars.mockImplementation(() => {
      throw new Error('no calendar');
    });
    expect(deviceHour12()).toBeUndefined();
  });

  it('takes ISO strings and epoch ms, and refuses garbage', () => {
    mockCalendars.mockReturnValue([{ uses24hourClock: true }]);
    expect(formatClockTime(new Date(AT).toISOString(), 'en')).toMatch(/19:30/);
    expect(formatClockTime('nope', 'en')).toBeNull();
    expect(formatClockTime(null, 'en')).toBeNull();
  });
});
