// formatTimeAgo's absolute branch (reached with absoluteAfterDays, e.g. from
// components/custom/article-meta-strings.ts) against the real i18n instance.
import { formatTimeAgo } from '@/lib/algorithms/time-ago';
import i18n from '@/lib/i18n';
import { useArticleMetaStrings } from '@/components/custom/article-meta-strings';
import { renderHook } from '@testing-library/react-native';
import { useFakeClock } from '@/test/helpers';

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

  // CO3. The absolute branch used to call toLocaleDateString() with no locale, so it followed the
  // device locale, not the language the reader picked inside the app: a German reader on an English
  // phone got "9/8/2026" next to German "vor 3 Tagen" labels.
  test('CO3: the absolute date follows the in-app language', async () => {
    useFakeClock(NOW);
    await i18n.changeLanguage('de');
    const { result } = renderHook(() => useArticleMetaStrings(new Date(thirtyDaysAgo).toISOString(), null, null));
    expect(result.current.age).toBe(new Date(thirtyDaysAgo).toLocaleDateString('de'));
  });

  it('falls back to the device locale for a malformed locale tag', () => {
    expect(formatTimeAgo(i18n.t, thirtyDaysAgo, { now: NOW, absoluteAfterDays: 7, locale: 'not a tag!' })).toBe(
      new Date(thirtyDaysAgo).toLocaleDateString(),
    );
  });
});
