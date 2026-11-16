// The Feed's age label: nothing under 24h, then local CALENDAR days (never hours).
import { feedAgeLabel } from '@/components/custom/feed/feed-age-label';
import i18n from 'i18next';
import { initI18nEn } from '@/test/helpers';

beforeAll(initI18nEn);
const t = ((k: string, o?: Record<string, unknown>) => (i18n.t as (k: string, o?: unknown) => string)(k, o)) as never;
const at = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h).getTime();
const NOW = at(2026, 10, 16, 9); // Mon 16 Nov 2026, 09:00 local

describe('feedAgeLabel', () => {
  it('is null under 24h and for an unparsable date', () => {
    expect(feedAgeLabel(new Date(NOW - 23 * 3600e3).toISOString(), NOW, 'en', t)).toBeNull();
    expect(feedAgeLabel('nope', NOW, 'en', t)).toBeNull();
  });
  it('says yesterday for the previous calendar day, even at 40h old', () => {
    expect(feedAgeLabel(at(2026, 10, 15, 8), NOW, 'en', t)).toBe('From yesterday');
    // 25h old at 1am: published the previous calendar day
    expect(feedAgeLabel(at(2026, 10, 15, 0), at(2026, 10, 16, 1), 'en', t)).toBe('From yesterday');
  });
  it('names the weekday 2 to 5 days back and a short date from 6', () => {
    expect(feedAgeLabel(at(2026, 10, 14, 17), NOW, 'en', t)).toBe('From Saturday');
    expect(feedAgeLabel(at(2026, 10, 11, 9), NOW, 'en', t)).toBe('From Wednesday');
    expect(feedAgeLabel(at(2026, 10, 10, 9), NOW, 'en', t)).toBe('From Nov 10');
  });
});
