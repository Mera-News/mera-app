// usePublicationPage: the publication page's hook, driven under renderHook with the real stores,
// the in-memory DB, the real profile/news/history hooks and MSW. Focus is a parameter. Faked:
// nothing (the page has no timers of its own). Session flags in article-service and
// publication-profile-service are module state, reset in beforeEach.
import { graphql, mockGql, mockGqlError, renderHookInScreen, server } from '@/test/helpers';
import { act, configure, waitFor } from '@testing-library/react-native';
import { usePublicationPage } from '@/components/custom/publication-page/usePublicationPage';
import type { PublicationView } from '@/components/custom/publication-page/open-publication-page';
import { __resetPublisherOrderSupport } from '@/lib/article-service';
import { __resetPublicationProfileSession } from '@/lib/publication-profile-service';
import { __clearPublisherSourceNames } from '@/lib/database/services/publisher-source-names';
import { recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import { useNetworkStore } from '@/lib/stores/network-store';
import { seedSuggestion } from '@/test/integration/feed/detail/seed';
import { articleFixtures } from '@/test/mock-backend/fixtures/articles';
import { publicationProfileFor } from '@/test/mock-backend/fixtures/graphql/publications';

// Several suites share the machine; waitFor's 1 s default is a flake source under load.
configure({ asyncUtilTimeout: 5000 });

const [PUB, OTHER] = articleFixtures.publications;
/** The fixture outlet's own articles (three), newest first. */
const OWN_IDS = articleFixtures.articles.filter((a) => a.publicationIndex === 0).map((a) => a.id);
const ALIAS = 'Fixtureville Courier Weekend';

type Sent = { op: string; vars: Record<string, any> };
/** Observes the named operations (the next handler still answers). */
function record(...ops: string[]) {
  const sent: Sent[] = [];
  server.use(
    graphql.operation(({ operationName, variables }) => {
      if (ops.includes(operationName)) sent.push({ op: operationName, vars: variables });
      return undefined;
    }),
  );
  return sent;
}
const opsOf = (sent: Sent[]) => sent.map((s) => s.op);

type Props = Parameters<typeof usePublicationPage>[0];
const open = (props: Partial<Props> & { order?: PublicationView }, focused = true) =>
  renderHookInScreen((p: Props) => usePublicationPage(p), {
    initialProps: { order: 'NEWEST', focused, ...props } as Props,
  });

beforeEach(() => {
  __resetPublisherOrderSupport();
  __resetPublicationProfileSession();
  __clearPublisherSourceNames();
});

describe('opening', () => {
  it('by publisher id: the profile and the news both load, news asked as Latest', async () => {
    const sent = record('PublicationProfile', 'GetArticlesForPublisher');
    const { result } = open({ publisherId: PUB.publisherId });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    await waitFor(() => expect(result.current.news.state).toBe('ready'));

    expect(result.current.profile?.name).toBe(PUB.name);
    expect(result.current.newsPublisherId).toBe(PUB.publisherId);
    expect(result.current.articles.map((a) => a._id)).toEqual(OWN_IDS);
    expect(result.current.shownOrder).toBe('NEWEST');
    expect(sent.find((s) => s.op === 'PublicationProfile')?.vars).toMatchObject({ newsPublisherId: PUB.publisherId });
    expect(sent.find((s) => s.op === 'GetArticlesForPublisher')?.vars).toMatchObject({
      newsPublisherId: PUB.publisherId,
      order: 'NEWEST',
    });
  });

  it('the news does not wait on the profile when the id is known', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.use(
      mockGql('PublicationProfile', async (vars) => {
        await held;
        return { publicationProfile: publicationProfileFor(vars as never) };
      }),
    );
    const { result } = open({ publisherId: PUB.publisherId });
    await waitFor(() => expect(result.current.news.state).toBe('ready'));
    expect(result.current.state).toBe('loading');
    expect(result.current.articles).toHaveLength(OWN_IDS.length);
    release();
    await waitFor(() => expect(result.current.state).toBe('ready'));
  });

  describe('the news request count while the profile lands', () => {
    const newsRequests = async () => {
      const sent = record('GetArticlesForPublisher');
      const { result } = open({ publisherId: PUB.publisherId });
      await waitFor(() => expect(result.current.state).toBe('ready'));
      await waitFor(() => expect(result.current.news.state).toBe('ready'));
      await act(async () => {
        for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
      });
      return sent.length;
    };

    test('asks for the first page once, whatever the profile later says', async () => {
      expect(await newsRequests()).toBe(1);
    });

    it('offline at open, the names landing later still fill the on-device list', async () => {
      await seedSuggestion({ _id: 'local-1', publication_name: PUB.name } as never);
      useNetworkStore.getState().setIsConnected(false);
      try {
        const { result } = open({ rawName: PUB.name, countryCode: PUB.countryCode });
        await waitFor(() => expect(result.current.news.isLocal).toBe(true));
        await waitFor(() => expect(result.current.articles.map((a) => a._id)).toEqual(['local-1']));
        expect(result.current.news.state).toBe('offline');
      } finally {
        useNetworkStore.getState().setIsConnected(true);
      }
    });
  });

  it('by raw name and country: the profile resolves by name, and the news follows its publisher id', async () => {
    const sent = record('PublicationProfile', 'GetArticlesForPublisher');
    const { result } = open({ rawName: PUB.name, countryCode: PUB.countryCode });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    await waitFor(() => expect(result.current.news.state).toBe('ready'));

    const profileCall = sent.find((s) => s.op === 'PublicationProfile')!;
    expect(profileCall.vars).toMatchObject({ name: PUB.name, countryCode: PUB.countryCode });
    expect(profileCall.vars.newsPublisherId).toBeUndefined(); // exactly one key mode
    expect(result.current.newsPublisherId).toBe(PUB.publisherId);
    expect(result.current.articles.map((a) => a._id)).toEqual(OWN_IDS);
  });
});

describe('when the publication is not found or the server is old', () => {
  it('PublicationProfile answering not found, opened by name: no news is requested', async () => {
    server.use(mockGql('PublicationProfile', { publicationProfile: null }));
    const sent = record('GetArticlesForPublisher', 'GetArticlesForPublisherNoOrder');
    const { result } = open({ rawName: 'Nowhere Gazette', countryCode: 'NLD' });
    await waitFor(() => expect(result.current.state).toBe('notFound'));
    expect(result.current.newsPublisherId).toBeNull();
    expect(result.current.newsAvailable).toBe(false);
    expect(result.current.articles).toEqual([]);
    await act(async () => {}); // let any stray request show up
    expect(sent).toEqual([]);
  });

  it('PublicationProfile answering not found, opened by id: the page shows no news (the id was asked once, while the profile was still loading)', async () => {
    server.use(mockGql('PublicationProfile', { publicationProfile: null }));
    const { result } = open({ publisherId: PUB.publisherId });
    await waitFor(() => expect(result.current.state).toBe('notFound'));
    expect(result.current.newsAvailable).toBe(false);
    expect(result.current.articles).toEqual([]);
  });

  it('an unsupported server, opened by id: the news still loads (Top headlines)', async () => {
    server.use(mockGqlError('PublicationProfile', 'GRAPHQL_VALIDATION_FAILED', { message: 'Cannot query field' }));
    // A server this old has no `order` either: it answers the plain document, which is top headlines.
    server.use(mockGqlError('GetArticlesForPublisher', 'GRAPHQL_VALIDATION_FAILED', { message: 'Unknown argument "order"' }));
    const sent = record('GetArticlesForPublisher', 'GetArticlesForPublisherNoOrder');
    const { result } = open({ publisherId: PUB.publisherId });
    await waitFor(() => expect(result.current.state).toBe('unsupported'));
    await waitFor(() => expect(result.current.news.state).toBe('ready'));
    expect(result.current.newsAvailable).toBe(true);
    expect(result.current.profile).toBeNull();
    expect(result.current.articles.map((a) => a._id)).toEqual(OWN_IDS);
    expect(result.current.shownOrder).toBe('TOP_HEADLINES');
    expect(opsOf(sent)).toEqual(['GetArticlesForPublisher', 'GetArticlesForPublisherNoOrder']);
  });

  it('an unsupported server, opened by name: no news at all (there is no publisher id to ask with)', async () => {
    server.use(mockGqlError('PublicationProfile', 'GRAPHQL_VALIDATION_FAILED', { message: 'Cannot query field' }));
    const sent = record('GetArticlesForPublisher', 'GetArticlesForPublisherNoOrder');
    const { result } = open({ rawName: PUB.name, countryCode: PUB.countryCode });
    await waitFor(() => expect(result.current.state).toBe('unsupported'));
    expect(result.current.newsAvailable).toBe(false);
    expect(result.current.articles).toEqual([]);
    await act(async () => {});
    expect(sent).toEqual([]);
  });

  it('the unsupported answer is remembered for the session: the next page does not ask again', async () => {
    server.use(mockGqlError('PublicationProfile', 'GRAPHQL_VALIDATION_FAILED'));
    const first = open({ rawName: PUB.name, countryCode: PUB.countryCode });
    await waitFor(() => expect(first.result.current.state).toBe('unsupported'));

    const sent = record('PublicationProfile');
    const second = open({ rawName: OTHER.name, countryCode: OTHER.countryCode });
    await waitFor(() => expect(second.result.current.state).toBe('unsupported'));
    expect(sent).toEqual([]);
  });
});

describe('the shown order', () => {
  it('Latest requested but the server applied no order: the shown order is Top headlines', async () => {
    server.use(mockGqlError('GetArticlesForPublisher', 'GRAPHQL_VALIDATION_FAILED', { message: 'Unknown argument "order"' }));
    const { result } = open({ publisherId: PUB.publisherId, order: 'NEWEST' });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    await waitFor(() => expect(result.current.news.state).toBe('ready'));
    expect(result.current.news.orderApplied).toBe(false);
    expect(result.current.shownOrder).toBe('TOP_HEADLINES');
    expect(result.current.articles.map((a) => a._id)).toEqual(OWN_IDS);
  });

  it('an old server is not a problem when Top headlines is what was asked: the shown order stays', async () => {
    server.use(mockGqlError('GetArticlesForPublisher', 'GRAPHQL_VALIDATION_FAILED'));
    const { result } = open({ publisherId: PUB.publisherId, order: 'TOP_HEADLINES' });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    await waitFor(() => expect(result.current.news.state).toBe('ready'));
    expect(result.current.news.orderApplied).toBe(true);
    expect(result.current.shownOrder).toBe('TOP_HEADLINES');
  });

  it('a server that applies the order keeps the shown order as asked', async () => {
    const sent = record('GetArticlesForPublisher');
    const { result } = open({ publisherId: PUB.publisherId, order: 'TOP_HEADLINES' });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    await waitFor(() => expect(result.current.news.state).toBe('ready'));
    expect(sent[0].vars.order).toBe('TOP_HEADLINES');
    expect(result.current.shownOrder).toBe('TOP_HEADLINES');
  });

  it('History is not a news order: the news stays requested as Latest', async () => {
    const sent = record('GetArticlesForPublisher');
    const { result } = open({ publisherId: PUB.publisherId, order: 'HISTORY' });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    await waitFor(() => expect(result.current.news.state).toBe('ready'));
    expect(sent[0].vars.order).toBe('NEWEST');
    expect(result.current.shownOrder).toBe('NEWEST');
    expect(result.current.isHistory).toBe(true);
  });
});

describe('history', () => {
  // The publication is known by two names: its profile name and an alias the feeds publish under.
  const twoNames = () =>
    server.use(
      mockGql('PublicationProfile', (vars) => ({
        publicationProfile: { ...publicationProfileFor(vars as never), sourceNames: [PUB.name, ALIAS] },
      })),
    );
  const visit = (publicationName: string, articleId: string) =>
    recordPublicationVisit({
      publicationName,
      countryCode: PUB.countryCode,
      articleId,
      articleUrl: `https://example.com/story/${articleId}`,
      titleEn: `Story ${articleId}`,
    });
  /** art-2 is opened once under each name; art-1 and art-3 under one name each. */
  const seedVisits = async () => {
    await visit(PUB.name, 'art-1');
    await visit(PUB.name, 'art-2');
    await visit(ALIAS, 'art-2');
    await visit(ALIAS, 'art-3');
    await visit('Some Other Paper', 'art-9'); // a different publication: never listed
  };

  it('visits recorded under both names are in the list, and visitCount sums the raw visits', async () => {
    twoNames();
    await seedVisits();
    const { result } = open({ publisherId: PUB.publisherId, order: 'HISTORY' });
    // The names grow when the profile lands, and the history is read again then.
    await waitFor(() => expect(result.current.visitCount).toBe(4));

    expect(result.current.history.visits.map((v) => v.articleId).sort()).toEqual(['art-1', 'art-2', 'art-3']);
    expect(result.current.visitCount).toBe(4); // art-2 counts once per name
    expect(result.current.articles.map((a) => a._id).sort()).toEqual(['art-1', 'art-2', 'art-3']);
    expect(result.current.openableHistoryIds).toEqual(new Set(['art-1', 'art-2', 'art-3']));
  });

  it('names the profile does not list are not matched: an alias visit is absent until the alias is a known name', async () => {
    await visit(PUB.name, 'art-1');
    await visit(ALIAS, 'art-3');
    const { result } = open({ publisherId: PUB.publisherId, order: 'HISTORY' }); // default profile: sourceNames = [PUB.name]
    await waitFor(() => expect(result.current.state).toBe('ready'));
    await waitFor(() => expect(result.current.visitCount).toBe(1));
    expect(result.current.history.visits.map((v) => v.articleId)).toEqual(['art-1']);
    expect(result.current.visitCount).toBe(1);
  });

  it('reads only while focused: a visit recorded while away shows on return', async () => {
    twoNames();
    const { result, rerender } = open({ publisherId: PUB.publisherId, order: 'HISTORY' }, false);
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.history.state).toBe('loading');
    expect(result.current.history.visits).toEqual([]);

    await visit(ALIAS, 'art-3');
    rerender({ publisherId: PUB.publisherId, order: 'HISTORY', focused: true } as Props);
    await waitFor(() => expect(result.current.history.state).toBe('ready'));
    expect(result.current.history.visits.map((v) => v.articleId)).toEqual(['art-3']);
    expect(result.current.visitCount).toBe(1);
  });

  it('without a profile (unsupported server) the page opened by name still lists visits under its raw name', async () => {
    server.use(mockGqlError('PublicationProfile', 'GRAPHQL_VALIDATION_FAILED'));
    await visit(PUB.name, 'art-1');
    const { result } = open({ rawName: PUB.name, countryCode: PUB.countryCode, order: 'HISTORY' });
    await waitFor(() => expect(result.current.history.state).toBe('ready'));
    expect(result.current.history.visits.map((v) => v.articleId)).toEqual(['art-1']);
  });
});
