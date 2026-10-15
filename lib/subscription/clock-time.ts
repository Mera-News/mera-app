// A time of day the way this phone shows its own clock: the device's 12/24h
// setting wins over the language's default (a 24h phone in English must not read
// "2:00 AM"). Falls back to the language default when the calendar is unknown.

import { getCalendars } from 'expo-localization';

/** `hour12` for toLocaleTimeString: the device setting, or undefined (locale default). */
export function deviceHour12(): boolean | undefined {
  try {
    const uses24h = getCalendars()[0]?.uses24hourClock;
    return uses24h == null ? undefined : !uses24h;
  } catch {
    return undefined;
  }
}

/** "22:06" / "10:06 PM" for an instant; null when unusable. */
export function formatClockTime(
  at: string | number | null | undefined,
  language?: string,
  hour12: boolean | undefined = deviceHour12(),
): string | null {
  if (at == null || at === '') return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit', hour12 });
  } catch {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12 });
  }
}
