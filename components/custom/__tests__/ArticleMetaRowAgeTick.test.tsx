// ArticleMetaRow — the LIVE AGE regression.
//
// The bug: a card read "37m ago" and still read "37m ago" 27 minutes later.
// `formatTimeAgo` is pure, so the label is only as fresh as the render that
// produced it, and every card that hosts this row is `React.memo`'d over a
// view-model that never changes — so the row rendered once and froze.
//
// These specs use the REAL `formatTimeAgo` (the sibling ArticleMetaRow.test.tsx
// stubs it to a constant '2h', which can't express "the string changed") and
// mount the row under a `React.memo` parent that is never re-rendered, which is
// exactly the boundary that used to trap the stale string.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: any) => (opts?.count != null ? `${key}:${opts.count}` : key),
  }),
}));
jest.mock('@/components/ui/box', () => {
  const { View } = require('react-native');
  return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
  const { View } = require('react-native');
  return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@expo/vector-icons', () => {
  const { View } = require('react-native');
  return { MaterialIcons: (p: any) => <View {...p} /> };
});
jest.mock('@/components/custom/SourceFlag', () => ({ SourceFlag: () => null }));
jest.mock('@/components/custom/SourceCountryFlag', () => ({ SourceCountryFlag: () => null }));
jest.mock('@/lib/stores/app-language-store', () => ({ useAppLanguage: () => 'en' }));
jest.mock('@/lib/translation-service', () => ({ getArticleTranslatableStatus: () => 'translatable' }));
jest.mock('@/lib/language-names', () => ({ getLocalizedLanguageName: () => 'German' }));
// NOTE: '@/lib/utils/time-ago' and '@/lib/time-tick' are deliberately NOT mocked.

// eslint-disable-next-line import/first
import { act, render } from '@testing-library/react-native';
// eslint-disable-next-line import/first
import React from 'react';
// eslint-disable-next-line import/first
import { ArticleMetaRow } from '../ArticleMetaRow';
// eslint-disable-next-line import/first
import { TIME_TICK_MS, __resetTimeTickForTests } from '@/lib/time-tick';

const MINUTE = 60_000;

/** A stand-in for the real card chrome: `React.memo` over a view-model that
 *  never changes, so this component renders exactly ONCE for the life of the
 *  test — the memo boundary the frozen age used to hide behind. */
let parentRenders = 0;
const MemoCard = React.memo(function MemoCard({ pubDate }: { pubDate: string }) {
  parentRenders += 1;
  return <ArticleMetaRow variant="card" pubDate={pubDate} languageCode="de" countryCode="DE" />;
});

describe('ArticleMetaRow — live age', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    __resetTimeTickForTests();
    parentRenders = 0;
  });

  afterEach(() => {
    __resetTimeTickForTests();
    jest.useRealTimers();
  });

  it('renders the age from the real clock on first paint', () => {
    const pubDate = new Date(Date.now() - 37 * MINUTE).toISOString();
    const { getByText } = render(<MemoCard pubDate={pubDate} />);
    expect(getByText('feed.minutesAgo:37')).toBeTruthy();
  });

  it('REGRESSION: the age string changes as the clock advances, under a memo that never re-renders', () => {
    const pubDate = new Date(Date.now() - 37 * MINUTE).toISOString();
    const { getByText, queryByText } = render(<MemoCard pubDate={pubDate} />);
    expect(getByText('feed.minutesAgo:37')).toBeTruthy();

    // The exact QA repro: 27 minutes later the card must not still say 37m.
    act(() => {
      jest.advanceTimersByTime(27 * MINUTE);
    });

    expect(queryByText('feed.minutesAgo:37')).toBeNull();
    expect(getByText('feed.hoursAgo:1')).toBeTruthy();
  });

  it('walks the ladder minute by minute (one tick ⇒ one minute of age)', () => {
    const pubDate = new Date(Date.now() - 5 * MINUTE).toISOString();
    const { getByText } = render(<MemoCard pubDate={pubDate} />);
    expect(getByText('feed.minutesAgo:5')).toBeTruthy();

    act(() => {
      jest.advanceTimersByTime(TIME_TICK_MS);
    });
    expect(getByText('feed.minutesAgo:6')).toBeTruthy();

    act(() => {
      jest.advanceTimersByTime(TIME_TICK_MS * 2);
    });
    expect(getByText('feed.minutesAgo:8')).toBeTruthy();
  });

  it('DECOUPLING: a tick re-renders the age row ONLY — the memo parent never re-renders', () => {
    const pubDate = new Date(Date.now() - 10 * MINUTE).toISOString();
    const { getByText } = render(<MemoCard pubDate={pubDate} />);
    expect(parentRenders).toBe(1);

    act(() => {
      jest.advanceTimersByTime(TIME_TICK_MS * 5);
    });

    // The label moved…
    expect(getByText('feed.minutesAgo:15')).toBeTruthy();
    // …and nothing above the row re-rendered, so no parent-derived ordering
    // (the Dashboard's throttled sort snapshot, buildFactRows) can be
    // recomputed by a clock tick.
    expect(parentRenders).toBe(1);
  });

  it('shares ONE timer across many mounted rows, and stops it when the last unmounts', () => {
    const pubDate = new Date(Date.now() - MINUTE).toISOString();
    const screens = Array.from({ length: 12 }, () => render(<MemoCard pubDate={pubDate} />));
    expect(jest.getTimerCount()).toBe(1);

    screens.forEach((s) => s.unmount());
    expect(jest.getTimerCount()).toBe(0);
  });

  it('leaves a missing pubDate on its empty label, ticking or not', () => {
    const { getAllByText } = render(<ArticleMetaRow variant="card" pubDate={null} />);
    expect(getAllByText('feed.justNow').length).toBeGreaterThan(0);

    act(() => {
      jest.advanceTimersByTime(TIME_TICK_MS * 10);
    });
    expect(getAllByText('feed.justNow').length).toBeGreaterThan(0);
  });
});
