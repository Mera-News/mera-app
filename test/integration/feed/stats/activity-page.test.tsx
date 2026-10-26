// The Library Activity page (StatsPage) and its screens' data hooks, over the real tables:
// visits, saves and follows are written through their own services. The page renders for
// real; navigation is the integration expo-router mock, so a card's tap is the route it
// pushes. History's country filter and the reading log's day filter run as their hooks.
// Mocked: the RN Modal native spec (the share preview), as restart-overlay-holds does.
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import React from 'react';

import StatsPage from '@/components/custom/library/StatsPage';
import { useHistory } from '@/components/custom/library/use-history';
import { useReadingLog } from '@/components/custom/library/use-reading-log';
import { usePendingPageStore } from '@/components/custom/nav/navigate-to-page';
import { recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import { saveStandaloneArticle } from '@/lib/database/services/saved-article-suggestion-service';
import { trackStory } from '@/lib/database/services/tracked-story-service';
import { localDateKey } from '@/lib/stats/reading-stats';
import { initI18nEn, renderHookInScreen } from '@/test/helpers';
import { newsArticle } from '../detail/seed';

jest.mock('react-native/Libraries/Modal/Modal', () => {
  const { View } = jest.requireActual('react-native');
  return { __esModule: true, default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) => (visible ? <View>{children}</View> : null) };
});

const HOUR = 3_600_000;
const LIBRARY = '/logged-in/app_container/library';

beforeAll(initI18nEn);
beforeEach(() => usePendingPageStore.setState({ request: null }));

async function visit(articleId: string, publicationName: string, countryCode: string, languageCode = 'fr') {
  await recordPublicationVisit({ articleId, publicationName, countryCode, languageCode, pubDate: Date.now() - 3 * HOUR });
}

const renderPage = () => render(<StatsPage active headerHeight={0} listEndPadding={0} />);
const pushedPath = () => (router.push as jest.Mock).mock.calls.at(-1)?.[0]?.pathname;

describe('the Activity page', () => {
  it('leads with Most opened, which opens History', async () => {
    await visit('a1', 'Le Monde', 'FRA');
    await visit('a2', 'Le Monde', 'FRA');
    await visit('a3', 'NRC', 'NLD', 'nl');
    const page = renderPage();
    await waitFor(() => expect(page.getByTestId('stat-tile-top')).toBeTruthy());

    expect(page.getByText('Your last 30 days')).toBeTruthy();
    expect(page.getByText('All 2 publications you opened')).toBeTruthy();
    expect(page.queryByTestId('stats-history-row')).toBeNull();
    fireEvent.press(page.getByTestId('stat-tile-top'));
    expect(pushedPath()).toBe(`${LIBRARY}/history`);
  });

  it('opens each card its screen', async () => {
    await visit('a1', 'Le Monde', 'FRA');
    const page = renderPage();
    await waitFor(() => expect(page.getByTestId('stat-tile-fresh')).toBeTruthy());

    const opens: [string, string][] = [
      ['publications', 'where-you-read'],
      ['languages', 'languages'],
      ['days', 'reading-log'],
      ['opened', 'reading-log'],
      ['fresh', 'freshness'],
    ];
    for (const [card, screen] of opens) {
      fireEvent.press(page.getByTestId(`stat-tile-${card}`));
      expect(pushedPath()).toBe(`${LIBRARY}/${screen}`);
    }
  });

  it('with no Most opened, a History row keeps History reachable, and Right now opens Saved and Stories', async () => {
    await saveStandaloneArticle(newsArticle('s1'));
    await trackStory({ articleId: 'f1', title: 'A followed story', originSurface: 'feed' });
    const page = renderPage();
    await waitFor(() => expect(page.getByTestId('stat-tile-now')).toBeTruthy());

    expect(page.queryByTestId('stat-tile-top')).toBeNull();
    fireEvent.press(page.getByTestId('stats-history-row'));
    expect(pushedPath()).toBe(`${LIBRARY}/history`);

    fireEvent.press(page.getByTestId('stats-now-saved'));
    expect(usePendingPageStore.getState().request?.page).toBe('saved');
    fireEvent.press(page.getByTestId('stats-now-followed'));
    expect(usePendingPageStore.getState().request?.page).toBe('stories');
  });

  it('Share enters select mode in place, every card a checkbox', async () => {
    await visit('a1', 'Le Monde', 'FRA');
    const page = renderPage();
    await waitFor(() => expect(page.getByTestId('stats-share')).toBeTruthy());

    fireEvent.press(page.getByTestId('stats-share'));
    expect(page.getByTestId('stats-preview')).toBeTruthy();
    expect(page.getByTestId('stat-tile-top').props.accessibilityRole).toBe('checkbox');
    expect(page.queryByTestId('stats-share')).toBeNull();
  });
});

describe('History', () => {
  it('a country shows only its publications, counting only its visits', async () => {
    await visit('a1', 'Le Monde', 'FRA');
    await visit('a2', 'NRC', 'NLD');
    // The same outlet filed under a second country counts there only.
    await visit('a3', 'Le Monde', 'BEL');

    const all = renderHookInScreen(() => useHistory(null));
    await waitFor(() => expect(all.result.current.loading).toBe(false));
    expect(all.result.current.items.map((i) => [i.publicationName, i.visitCount])).toEqual(
      expect.arrayContaining([['Le Monde', 2], ['NRC', 1]]),
    );

    const fr = renderHookInScreen(() => useHistory('FRA'));
    await waitFor(() => expect(fr.result.current.loading).toBe(false));
    expect(fr.result.current.items.map((i) => [i.publicationName, i.countryCode, i.visitCount])).toEqual([['Le Monde', 'FRA', 1]]);
  });
});

describe('What you opened', () => {
  it('a picked day narrows the list; Show all days (null) brings every day back; a language narrows both', async () => {
    await visit('a1', 'Le Monde', 'FRA', 'fr');
    await visit('a2', 'NRC', 'NLD', 'nl');
    const today = localDateKey(Date.now());

    const log = renderHookInScreen(() => useReadingLog({ language: null, initialDay: null }));
    await waitFor(() => expect(log.result.current.all).toHaveLength(2));
    expect(log.result.current.days.at(-1)).toMatchObject({ dateKey: today, count: 2 });

    act(() => log.result.current.setDay('2001-01-01'));
    expect(log.result.current.rows).toHaveLength(0);
    act(() => log.result.current.setDay(today));
    expect(log.result.current.rows).toHaveLength(2);
    act(() => log.result.current.setDay(null));
    expect(log.result.current.rows).toHaveLength(2);

    const nl = renderHookInScreen(() => useReadingLog({ language: 'nl', initialDay: today }));
    await waitFor(() => expect(nl.result.current.rows.map((v) => v.articleId)).toEqual(['a2']));
    expect(nl.result.current.days.at(-1)?.count).toBe(1);
  });
});
