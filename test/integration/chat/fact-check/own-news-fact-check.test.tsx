// Fact checks while the person uses their own news server: entry points are gone, a stored pending
// check shows one "off" line and nothing polls, a stored answer still shows, and turning the mode
// off brings it all back with no restart. Real screens, stores and DB; MSW counts requests on both
// hosts. Mocked: the RN Modal spec, reanimated, the safe area.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { NavigationRouteContext } from 'expo-router/react-navigation';
import client from '@/lib/apollo-client';
import ArticleSuggestionCard from '@/components/custom/cards/ArticleSuggestionCard';
import ArticleDetailScreen from '@/components/custom/news-detail/ArticleDetailScreen';
import FactCheckPanel from '@/components/custom/news-detail/FactCheckPanel';
import { upsertFactCheck } from '@/lib/database/services/fact-check-record-service';
import { stopAskedFactCheckPollerForTest } from '@/lib/fact-check/fact-check-graphql-client';
import { recordFactCheckAsked } from '@/lib/fact-check/fact-check-settled';
import { POLL_CEILING_MS, POLL_INTERVAL_MS } from '@/lib/fact-check/fact-check-state';
import { ownNewsState, recordOwnNewsCheck, saveOwnNewsFields, setOwnNewsOn } from '@/lib/own-services/own-news-state';
import { http, HttpResponse, initI18nEn, server, signInFixtureAccount } from '@/test/helpers';
import { ARTICLE_IDS } from '@/test/mock-backend/fixtures/articles';
import { resetLinkState } from '@/test/integration/data/apollo/link-chain/kit';
import { newsArticle, seedSuggestion } from '@/test/integration/feed/detail/seed';
import { resetChatModules, useStrictClock as installStrictClock } from '@/test/integration/chat/_helpers';
import { advanceAnd, checkRow, pendingRow, realTurn, serveChecks } from './kit';

jest.mock('react-native/Libraries/Modal/Modal', () => {
  const { View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
      visible ? <View>{children}</View> : null,
  };
});
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated/mock');
  return { ...actual, __esModule: true, default: actual.default ?? actual, useReducedMotion: () => true };
});
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context/jest/mock').default,
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
  initialWindowMetrics: { insets: { top: 47, bottom: 34, left: 0, right: 0 }, frame: { x: 0, y: 0, width: 390, height: 844 } },
}));

const OFF_LINE = 'Fact checks are off while you use your own news server.';
const TICK = 'card-action-fact-check';
const ARTICLE = { title: 'Headline', language: 'en', publication: 'Organiser', pubDate: '2026-10-24T08:00:00.000Z', url: 'https://organiser.org/story' };

const turnOnNews = async () => {
  await saveOwnNewsFields({ baseUrl: 'https://news.own.test', key: 'own-news-key-12345678' });
  await recordOwnNewsCheck('connected', null);
  await setOwnNewsOn(true, { at: 1, privacyVersion: null });
};

/** Every GraphQL operation name that reaches either host, in order. */
let ops: { host: string; op: string }[];
let stopWatching: () => void;
const factOps = () => ops.filter((o) => /FactCheck/.test(o.op));

const flush = (turns = 40) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(0);
    for (let i = 0; i < turns; i++) await realTurn();
  });
const tick = (ms: number) =>
  act(async () => {
    await advanceAnd(ms, () => true, 40);
  });

const seedPending = () =>
  upsertFactCheck({ articleId: 'a1', factCheckId: 'fc-a1', status: 'pending', payload: pendingRow() });
const seedComplete = () =>
  upsertFactCheck({
    articleId: 'a1',
    factCheckId: 'fc-a1',
    status: 'complete',
    payload: checkRow({
      summary: 'The factual claims are supported by independent reporting.',
      checkedBy: [{ organisation: 'FACTLY', verdict: 'MISLEADING', summary: 'An unrelated video.', url: 'https://factly.in/a' }],
      claims: [{ claim: 'Leaders were detained.', assessment: 'supported' }],
      recheckAvailableAt: new Date(Date.now() - 1000).toISOString(),
    }),
  });

beforeAll(initI18nEn);
beforeEach(async () => {
  resetChatModules();
  resetLinkState();
  ownNewsState.resetMemory();
  await client.clearStore();
  await signInFixtureAccount();
  installStrictClock(Date.now());
  ops = [];
  const listener = async ({ request }: { request: Request }) => {
    if (request.method !== 'POST' || !request.url.endsWith('/graphql')) return;
    const body = (await request.clone().json().catch(() => ({}))) as { operationName?: string };
    ops.push({ host: new URL(request.url).host, op: String(body.operationName) });
  };
  server.events.on('request:start', listener);
  stopWatching = () => server.events.removeListener('request:start', listener);
  server.use(
    http.post('https://news.own.test/graphql', async ({ request }) => {
      const body = (await request.clone().json()) as { operationName?: string; variables?: { id?: string } };
      if (body.operationName === 'GetArticleById') {
        return HttpResponse.json({ data: { articleById: newsArticle(String(body.variables?.id), { title: 'Headline', title_en_internal_only: 'Headline' }) } });
      }
      return HttpResponse.json({ errors: [{ message: 'not served here' }] });
    }),
  );
});
afterEach(() => {
  stopWatching();
  stopAskedFactCheckPollerForTest();
  jest.restoreAllMocks();
});

/** Is the "Check facts" entry reachable on a card: inline, or inside the ••• sheet? */
const cardOffersCheck = async () => {
  const more = screen.queryByTestId('card-action-more');
  if (more) {
    await act(async () => {
      fireEvent.press(more);
    });
  }
  return screen.queryByTestId(TICK) !== null;
};

const mountCard = async () => {
  const suggestion = await seedSuggestion({ _id: 'art-1', article_url: 'https://example.com/story' } as never);
  await render(<ArticleSuggestionCard suggestion={suggestion} onPress={() => undefined} onVerdict={() => undefined} />);
  await flush();
};

const mountDetail = async () => {
  await render(
    <NavigationRouteContext.Provider value={{ key: 'article-1', name: 'article' }}>
      <ArticleDetailScreen articleId={ARTICLE_IDS[0]} onBack={() => undefined} />
    </NavigationRouteContext.Provider>,
  );
  await flush();
};

describe('own news on: entry points', () => {
  it('shows no tick on the article screen, no "Check facts" on a card, and sends no fact-check document', async () => {
    await turnOnNews();
    await mountDetail();
    await tick(1000);
    expect(screen.queryByTestId(TICK)).toBeNull();
    screen.unmount();

    await mountCard();
    expect(await cardOffersCheck()).toBe(false);
    expect(factOps()).toEqual([]);
  });

  it('negative control, own news off: the tick and the card entry are back', async () => {
    await mountDetail();
    await tick(1000);
    expect(await cardOffersCheck()).toBe(true);
    screen.unmount();
    await mountCard();
    expect(await cardOffersCheck()).toBe(true);
  });
});

describe('own news on: stored rows', () => {
  it('a pending row shows the off line, no spinner, no "Fact check again", and stays so past the poll ceiling with zero requests', async () => {
    await seedPending();
    await recordFactCheckAsked({ articleId: 'a1', suggestionId: null, title: 'a1' });
    await turnOnNews();
    serveChecks({});
    await render(<FactCheckPanel articleId="a1" article={ARTICLE} />);
    await flush();

    expect(screen.getByText(OFF_LINE)).toBeTruthy();
    expect(screen.queryByTestId('fact-check-working')).toBeNull();
    expect(screen.queryByText('Fact check again')).toBeNull();

    await tick(POLL_CEILING_MS + 2 * POLL_INTERVAL_MS);

    expect(screen.getByText(OFF_LINE)).toBeTruthy();
    expect(screen.queryByTestId('fact-check-stalled')).toBeNull();
    expect(factOps()).toEqual([]);
  });

  it('a complete row still shows its organisation and claims, without "Fact check again"', async () => {
    await seedComplete();
    await turnOnNews();
    await render(<FactCheckPanel articleId="a1" article={ARTICLE} />);
    await flush();

    expect(screen.getByText('FACTLY')).toBeTruthy();
    expect(screen.getByText('Leaders were detained.')).toBeTruthy();
    expect(screen.queryByText('Fact check again')).toBeNull();
    expect(screen.queryByText(OFF_LINE)).toBeNull();
    expect(factOps()).toEqual([]);
  });
});

describe('own news off', () => {
  it('negative control: a pending row asked here polls Mera as today and shows no off line', async () => {
    await seedPending();
    await recordFactCheckAsked({ articleId: 'a1', suggestionId: null, title: 'a1' });
    const wire = serveChecks({ ask: () => pendingRow() });
    await render(<FactCheckPanel articleId="a1" article={ARTICLE} />);
    await flush();

    expect(wire.length).toBeGreaterThan(0);
    expect(screen.queryByText(OFF_LINE)).toBeNull();
  });

  it('turning the mode off brings the poll, the line and the entry points back without a restart', async () => {
    await seedPending();
    await recordFactCheckAsked({ articleId: 'a1', suggestionId: null, title: 'a1' });
    await turnOnNews();
    const wire = serveChecks({ ask: () => pendingRow() });
    await render(<FactCheckPanel articleId="a1" article={ARTICLE} />);
    await flush();
    expect(screen.getByText(OFF_LINE)).toBeTruthy();
    expect(wire).toEqual([]);

    await act(async () => {
      await setOwnNewsOn(false);
    });
    await flush();

    expect(screen.queryByText(OFF_LINE)).toBeNull();
    expect(wire.length).toBeGreaterThan(0);
  });
});
