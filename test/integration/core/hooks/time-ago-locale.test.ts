// formatTimeAgo's absolute branch (reached with absoluteAfterDays, e.g. from
// components/custom/article-meta-strings.ts) against the real i18n instance.
import { formatTimeAgo } from '@/lib/utils/time-ago';
import i18n from '@/lib/i18n';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const DAY = 86_400_000;

afterEach(() => i18n.changeLanguage('en'));

describe('formatTimeAgo', () => {
  it('keeps the relative ladder inside absoluteAfterDays', async () => {
    await i18n.changeLanguage('en');
    expect(formatTimeAgo(i18n.t, NOW - 3 * DAY, { now: NOW, absoluteAfterDays: 7 })).toBe(i18n.t('feed.daysAgo', { count: 3 }));
  });

  it('switches to an absolute date at absoluteAfterDays', async () => {
    await i18n.changeLanguage('en');
    const thirtyDaysAgo = NOW - 30 * DAY;
    expect(formatTimeAgo(i18n.t, thirtyDaysAgo, { now: NOW, absoluteAfterDays: 7 })).toBe(
      new Date(thirtyDaysAgo).toLocaleDateString(),
    );
  });
});

describe('absolute date in the in-app language (CO3)', () => {
  const thirtyDaysAgo = NOW - 30 * DAY;

  // CO3. The absolute branch calls toLocaleDateString() with no locale, so it follows the device
  // locale, not the language the reader picked inside the app: a German reader on an English phone
  // gets "9/8/2026" next to German "vor 3 Tagen" labels.
  test.failing('CO3: the absolute date follows the in-app language', async () => {
    await i18n.changeLanguage('de');
    expect(formatTimeAgo(i18n.t, thirtyDaysAgo, { now: NOW, absoluteAfterDays: 7 })).toBe(
      new Date(thirtyDaysAgo).toLocaleDateString('de'),
    );
  });

  test('CO3 (today): the absolute date ignores the in-app language and uses the device locale', async () => {
    await i18n.changeLanguage('de');
    const label = formatTimeAgo(i18n.t, thirtyDaysAgo, { now: NOW, absoluteAfterDays: 7 });
    expect(label).toBe(new Date(thirtyDaysAgo).toLocaleDateString());
    expect(label).not.toBe(new Date(thirtyDaysAgo).toLocaleDateString('de'));
  });
});
