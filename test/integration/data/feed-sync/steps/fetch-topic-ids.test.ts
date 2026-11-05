// stepFetchTopicIds against the real topic, fact and location services, the in-memory DB and the
// real Apollo client on MSW. Replaces the stepFetchTopicIds half of
// lib/scheduler/feed-sync/__tests__/feed-sync-steps.test.ts.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

import { addFact } from '@/lib/database/services/fact-service';
import { setHeadlineDepth } from '@/lib/database/services/headline-depth-service';
import { deleteTopicWithDecline } from '@/lib/database/services/topic-decline-service';
import { getSetting } from '@/lib/database/services/setting-service';
import { countAllTopics } from '@/lib/database/services/topic-service';
import {
  stepFetchTopicIds,
  TOPIC_CURSOR_KEY,
  TOPIC_FETCH_BUDGET_MS,
} from '@/lib/scheduler/feed-sync/feed-sync-steps';
import logger from '@/lib/logger';
import { graphql, HttpResponse, mockGql, server } from '@/test/helpers';
import {
  cleanupFeedSync,
  failSettingRead,
  makeCtx,
  markPersonaMigrated,
  recordOps,
  resetFeedSyncMemory,
  seedInterest,
  seedLocation,
  seedTracked,
  servePersona,
  spyOnExport,
} from './support';
import { PERSONA_V3_MIGRATION_KEY } from '@/lib/services/persona-migration-service';

beforeEach(resetFeedSyncMemory);
afterEach(cleanupFeedSync);

describe('which retrieval path runs', () => {
  it('asks the persona query when the device has active topics', async () => {
    await seedInterest('I follow Formula 1 racing', ['formula 1']);
    const sent = recordOps();

    const out = await stepFetchTopicIds('', makeCtx().ctx);

    expect(await sent.count('GetArticleIdsForPersona')).toBe(1);
    expect(await sent.count('GetArticleIdsForTopics')).toBe(0);
    expect(out.personaMeta).toBeDefined();
    expect(out.freeTopicTexts).toEqual(new Set());
  });

  it('with no topic rows at all, reads the topics off fact.metadata.topics and asks the legacy query at 100 per topic', async () => {
    await markPersonaMigrated();
    // A fact written with its list but no topic rows: what a device that never migrated holds.
    await addFact('I follow racing', { topics: ['formula 1', 'motogp', 'formula 1', ''] });
    const sent = recordOps();

    const out = await stepFetchTopicIds('', makeCtx().ctx);

    expect(await sent.count('GetArticleIdsForPersona')).toBe(0);
    const [legacy] = await sent.named('GetArticleIdsForTopics');
    expect(legacy.variables.topics).toEqual([{ topicText: 'formula 1' }, { topicText: 'motogp' }]);
    expect(legacy.variables.limitPerTopic).toBe(100);
    expect(out.personaMeta).toBeUndefined();
    expect(out.freeTopicTexts).toBeUndefined();
    expect(out.serverArticleIds.length).toBeGreaterThan(0);
  });

  it('on the legacy path skips a fact that has no metadata.topics at all', async () => {
    await markPersonaMigrated();
    await addFact('I like walking');
    await addFact('I follow racing', { topics: ['formula 1'] });
    const sent = recordOps();

    await stepFetchTopicIds('', makeCtx().ctx);

    const [legacy] = await sent.named('GetArticleIdsForTopics');
    expect(legacy.variables.topics).toEqual([{ topicText: 'formula 1' }]);
  });

  it('on the legacy path an article matched by two topics lists both texts and appears once', async () => {
    await markPersonaMigrated();
    await addFact('I follow racing', { topics: ['alpha', 'beta'] });
    server.use(
      mockGql('GetArticleIdsForTopics', {
        articleIdsForTopics: {
          __typename: 'ArticleIdsForTopicsResponse',
          results: [
            { __typename: 'TopicArticleIdsResult', topicText: 'alpha', articleIds: ['x1', 'x2'], hasNextPage: false, nextCursor: null },
            { __typename: 'TopicArticleIdsResult', topicText: 'beta', articleIds: ['x2', 'x3'], hasNextPage: false, nextCursor: null },
          ],
        },
      }),
    );

    const out = await stepFetchTopicIds('', makeCtx().ctx);

    expect(out.serverArticleIds).toEqual(['x1', 'x2', 'x3']);
    expect(out.articleToTopicTexts.get('x2')).toEqual(['alpha', 'beta']);
  });

  it('with no topics anywhere, fails terminal with no-topics-configured and asks the server nothing', async () => {
    await markPersonaMigrated();
    const sent = recordOps();

    await expect(stepFetchTopicIds('', makeCtx().ctx)).rejects.toMatchObject({
      message: 'no-topics-configured',
      code: 'no-topics-configured',
    });
    expect(await sent.all()).toEqual([]);
  });

  it('a fact and a location with no topics yet fetches headlines for the country and the world', async () => {
    await markPersonaMigrated();
    await addFact('Lives in Amsterdam, North Holland, Netherlands');
    await seedLocation('NL', 0.6);
    const sent = recordOps();

    await stepFetchTopicIds('', makeCtx().ctx);

    expect(await sent.count('GetArticleIdsForTopics')).toBe(0);
    const [persona] = await sent.named('GetArticleIdsForPersona');
    expect(persona.variables.query.topics).toEqual([]);
    expect(persona.variables.query.topHeadlines.scopes).toEqual([
      { scope: 'COUNTRY', countryCode: 'NL' },
      { scope: 'GLOBAL', countryCode: null },
    ]);
  });

  // DA45: a reader who follows only staged or muted topics still gets headlines. The profile always
  // carries a GLOBAL scope, so the request is sent with an empty topic list.
  test('DA45: staged-only topics still fetch headlines (no topics, GLOBAL plus the country scope)', async () => {
    await markPersonaMigrated();
    const { topics } = await seedInterest('I follow racing', ['staged topic']);
    await deleteTopicWithDecline(topics[0].id, { undoWindowMs: 60_000 });
    await seedLocation('NL', 0.9);
    const sent = recordOps();

    await stepFetchTopicIds('', makeCtx().ctx);

    // the persona path is taken: the legacy query (which would carry the staged text) is never sent
    expect(await sent.count('GetArticleIdsForTopics')).toBe(0);
    const persona = await sent.named('GetArticleIdsForPersona');
    expect(persona).toHaveLength(1);
    expect(persona[0].variables.query.topics).toEqual([]);
    expect(persona[0].variables.query.topHeadlines.scopes).toEqual([
      { scope: 'COUNTRY', countryCode: 'NL' },
      { scope: 'GLOBAL', countryCode: null },
    ]);
  });

  it('a staged topic beside an active one: only the active text is requested', async () => {
    const { topics } = await seedInterest('I follow racing', ['stays', 'goes']);
    await deleteTopicWithDecline(topics[1].id, { undoWindowMs: 60_000 });
    const sent = recordOps();

    await stepFetchTopicIds('', makeCtx().ctx);

    const [persona] = await sent.named('GetArticleIdsForPersona');
    expect(persona.variables.query.topics.map((t: { text: string }) => t.text)).toEqual(['stays']);
  });

  test('DA45: with no positive topic the sync still fetches headlines', async () => {
    await markPersonaMigrated();
    await seedInterest('I follow racing', [{ text: 'muted', weight: -0.5 }]);
    await seedLocation('NL', 0.9);
    const sent = recordOps();

    await stepFetchTopicIds('', makeCtx().ctx);

    const persona = await sent.named('GetArticleIdsForPersona');
    expect(persona).toHaveLength(1);
    expect(persona[0].variables.query.topics).toEqual([]);
    expect(persona[0].variables.query.topHeadlines.scopes).toEqual([
      { scope: 'COUNTRY', countryCode: 'NL' },
      { scope: 'GLOBAL', countryCode: null },
    ]);
  });

  it('runs the persona migration first, so a never-migrated device takes the persona path on its first sync', async () => {
    await addFact('I follow racing', { topics: ['formula 1'] });
    expect(await countAllTopics()).toBe(0);
    const sent = recordOps();

    await stepFetchTopicIds('', makeCtx().ctx);

    expect(await countAllTopics()).toBe(1);
    expect(await sent.count('GetArticleIdsForPersona')).toBe(1);
    expect(await sent.count('GetArticleIdsForTopics')).toBe(0);
  });

  it('a failing persona migration is reported and the sync carries on with what is on the device', async () => {
    await addFact('I follow racing', { topics: ['formula 1'] });
    failSettingRead(PERSONA_V3_MIGRATION_KEY);
    const sent = recordOps();

    const out = await stepFetchTopicIds('', makeCtx().ctx);

    expect(logger.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ method: 'runPersonaMigrationIfNeeded' }) }),
    );
    // no topic rows were written, so it fell back to the legacy list
    expect(await sent.count('GetArticleIdsForTopics')).toBe(1);
    expect(out.serverArticleIds.length).toBeGreaterThan(0);
  });

  it('an already-aborted signal throws a cancellation before touching the server', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    const t = makeCtx();
    t.abort();
    const sent = recordOps();

    await expect(stepFetchTopicIds('', t.ctx)).rejects.toMatchObject({ name: 'AbortError', message: 'aborted' });

    expect(await sent.all()).toEqual([]);
  });
});

describe('what the step logs', () => {
  it('names the persona request size and the id count it got back', async () => {
    await seedInterest('I follow racing', ['formula 1', 'motogp']);
    server.use(servePersona({ topics: { 'formula 1': ['p1', 'p2'] } }));
    const t = makeCtx();

    await stepFetchTopicIds('', t.ctx);

    expect(t.log).toHaveBeenCalledWith('fetching persona ids for 2 topics + 1 scopes');
    expect(t.log).toHaveBeenCalledWith('server returned 2 article ids (persona path)');
  });

  it('names the legacy request size and the id count it got back', async () => {
    await markPersonaMigrated();
    await addFact('I follow racing', { topics: ['alpha', 'beta'] });
    const t = makeCtx();

    const out = await stepFetchTopicIds('', t.ctx);

    expect(t.log).toHaveBeenCalledWith('fetching ids for 2 topics (legacy path)');
    expect(t.log).toHaveBeenCalledWith(`server returned ${out.serverArticleIds.length} article ids`);
  });
});

describe('what the persona request carries', () => {
  it('sends each active topic text with a limit, and nothing but text, limit and strictMatch', async () => {
    await seedInterest('I follow racing', [{ text: 'formula 1', weight: 1 }, { text: 'motogp', weight: 0.5 }]);
    const sent = recordOps();

    await stepFetchTopicIds('', makeCtx().ctx);

    const [{ variables }] = await sent.named('GetArticleIdsForPersona');
    expect(variables.query.limitPerTopic).toBe(40);
    const topics = variables.query.topics as { text: string; limit: number }[];
    expect(topics.map((t) => t.text).sort()).toEqual(['formula 1', 'motogp']);
    for (const t of topics) {
      expect(Object.keys(t).sort()).toEqual(['limit', 'text']);
      expect(t.limit).toBeGreaterThan(0);
    }
    // the higher-weighted topic is not given a smaller limit
    const limitOf = (text: string) => topics.find((t) => t.text === text)!.limit;
    expect(limitOf('formula 1')).toBeGreaterThanOrEqual(limitOf('motogp'));
  });

  describe('a list past one batch', () => {
    const texts = (prefix: string, count: number, from = 0) =>
      Array.from({ length: count }, (_, i) => `${prefix} ${String(from + i).padStart(3, '0')}`);
    type Asked = { text: string };
    const batchesOf = async (sent: ReturnType<typeof recordOps>) =>
      (await sent.named('GetArticleIdsForPersona')).map(({ variables }) => variables.query as { topics: Asked[]; topHeadlines?: unknown });
    const reply = (topics: Asked[], headlineIds: string[] = []) =>
      HttpResponse.json({
        data: {
          articleIdsForPersona: {
            __typename: 'PersonaQueryResult',
            topicResults: topics.map((t) => ({
              __typename: 'PersonaTopicResult',
              topicText: t.text,
              articleIds: [`id ${t.text}`],
              matchMeta: [],
              nextCursor: null,
              hasNextPage: false,
            })),
            headlineResults: headlineIds.length
              ? [{ __typename: 'HeadlineScopeResult', scope: 'GLOBAL', countryCode: null, articleIds: headlineIds, clusterSizes: headlineIds.map(() => 1), stableClusterIds: headlineIds }]
              : [],
          },
        },
      });
    const resolverError = () =>
      HttpResponse.json({ data: null, errors: [{ message: 'resolver timed out', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
    /** Answers every batch; `fail` decides per batch whether this request errors. */
    const serveBatches = (fail: (firstText: string) => boolean = () => false, onBatch: (firstText: string) => void = () => {}) =>
      graphql.query('GetArticleIdsForPersona', ({ variables }) => {
        const query = variables.query as { topics: Asked[]; topHeadlines?: unknown };
        const first = query.topics[0]?.text ?? '';
        onBatch(first);
        return (fail(first) ? resolverError() : reply(query.topics, query.topHeadlines ? ['headline'] : [])) as never;
      });

    it('asks for every topic in batches of 150, with the headlines on the first batch only', async () => {
      await seedInterest('I read everything', texts('aaa', 320));
      server.use(serveBatches());
      const sent = recordOps();

      const out = await stepFetchTopicIds('', makeCtx().ctx);

      const batches = await batchesOf(sent);
      expect(batches.map((b) => b.topics.length)).toEqual([150, 150, 20]);
      expect(batches.map((b) => b.topHeadlines != null)).toEqual([true, false, false]);
      expect(new Set(batches.flatMap((b) => b.topics.map((t) => t.text))).size).toBe(320);
      expect(out.serverArticleIds).toHaveLength(321);
      expect(out.serverArticleIds.at(-1)).toBe('headline');
    });

    it('puts followed topics in the earliest batches, whatever their weight', async () => {
      await seedInterest('I read everything', texts('aaa', 200));
      await seedTracked('zzz story', 0.1);
      const sent = recordOps();

      await stepFetchTopicIds('', makeCtx().ctx);

      const [first] = await batchesOf(sent);
      expect(first.topics[0].text).toBe('zzz story');
    });

    it('a batch that fails once is the only one asked again', async () => {
      await seedInterest('I read everything', texts('aaa', 320));
      let failures = 1;
      const seen: string[] = [];
      server.use(
        serveBatches(
          (first) => first === 'aaa 150' && failures-- > 0,
          (first) => seen.push(first),
        ),
      );

      const out = await stepFetchTopicIds('', makeCtx().ctx);

      expect(seen).toEqual(['aaa 000', 'aaa 150', 'aaa 150', 'aaa 300']);
      expect(out.serverArticleIds).toHaveLength(321);
    });

    it('a batch that stays down keeps what arrived, and the next sync starts at it with the headlines', async () => {
      await seedInterest('I read everything', texts('aaa', 320));
      let down = true;
      const seen: string[] = [];
      server.use(serveBatches((first) => down && first === 'aaa 150', (first) => seen.push(first)));

      const short = await stepFetchTopicIds('', makeCtx().ctx);

      expect(seen).toEqual(['aaa 000', 'aaa 150', 'aaa 150']);
      expect(short.serverArticleIds).toHaveLength(151);

      down = false;
      seen.length = 0;
      const sent = recordOps();
      const resumed = await stepFetchTopicIds('', makeCtx().ctx);

      expect(seen).toEqual(['aaa 150', 'aaa 300']);
      expect((await batchesOf(sent))[0].topHeadlines).toBeDefined();
      expect(resumed.serverArticleIds).toHaveLength(171);

      seen.length = 0;
      await stepFetchTopicIds('', makeCtx().ctx);
      expect(seen).toEqual(['aaa 000', 'aaa 150', 'aaa 300']);
    });

    it('stops at the time budget, keeps what arrived, and the next sync goes on from the first topic not fetched', async () => {
      await seedInterest('I read everything', texts('aaa', 320));
      let now = Date.now();
      spyOnExport(Date, 'now').mockImplementation(() => now);
      const seen: string[] = [];
      server.use(serveBatches(() => false, (first) => {
        seen.push(first);
        now += TOPIC_FETCH_BUDGET_MS;
      }));

      const short = await stepFetchTopicIds('', makeCtx().ctx);

      expect(seen).toEqual(['aaa 000']);
      expect(short.serverArticleIds).toHaveLength(151);

      seen.length = 0;
      await stepFetchTopicIds('', makeCtx().ctx);
      expect(seen).toEqual(['aaa 150']);
    });

    it('a first batch with nothing before it fails the sync as it always did', async () => {
      await seedInterest('I read everything', texts('aaa', 320));
      server.use(serveBatches(() => true));

      await expect(stepFetchTopicIds('', makeCtx().ctx)).rejects.toBeDefined();
    });

    it('a resumed sync whose first batch fails goes back to the top, so one bad batch cannot hold the headlines', async () => {
      await seedInterest('I read everything', texts('aaa', 320));
      server.use(serveBatches((first) => first === 'aaa 150'));
      await stepFetchTopicIds('', makeCtx().ctx);

      await expect(stepFetchTopicIds('', makeCtx().ctx)).rejects.toBeDefined();

      const seen: string[] = [];
      server.use(serveBatches(() => false, (first) => seen.push(first)));
      await stepFetchTopicIds('', makeCtx().ctx);
      expect(seen[0]).toBe('aaa 000');
    });

    it('a cursor on a topic that has since gone starts from the top', async () => {
      const { topics } = await seedInterest('I read everything', texts('aaa', 320));
      server.use(serveBatches((first) => first === 'aaa 150'));
      await stepFetchTopicIds('', makeCtx().ctx);
      await deleteTopicWithDecline(topics.find((t) => t.text === 'aaa 150')!.id, { undoWindowMs: 60_000 });

      const seen: string[] = [];
      server.use(serveBatches(() => false, (first) => seen.push(first)));
      await stepFetchTopicIds('', makeCtx().ctx);

      expect(seen[0]).toBe('aaa 000');
    });

    it('an unreadable cursor row costs a full pass, not the sync', async () => {
      await seedInterest('I read everything', texts('aaa', 320));
      failSettingRead(TOPIC_CURSOR_KEY);
      const seen: string[] = [];
      server.use(serveBatches(() => false, (first) => seen.push(first)));

      await stepFetchTopicIds('', makeCtx().ctx);

      expect(seen).toEqual(['aaa 000', 'aaa 150', 'aaa 300']);
    });

    it('an abort mid-list is a cancellation and moves no cursor', async () => {
      await seedInterest('I read everything', texts('aaa', 320));
      const t = makeCtx();
      server.use(serveBatches((first) => {
        if (first === 'aaa 150') t.abort();
        return false;
      }));

      await expect(stepFetchTopicIds('', t.ctx)).rejects.toMatchObject({ name: 'AbortError' });

      expect(await getSetting(TOPIC_CURSOR_KEY)).toBeNull();
    });

    it('a background run starts at the top and leaves the foreground cursor alone', async () => {
      await seedInterest('I read everything', texts('aaa', 320));
      server.use(serveBatches((first) => first === 'aaa 150'));
      await stepFetchTopicIds('', makeCtx().ctx);
      const cursor = await getSetting(TOPIC_CURSOR_KEY);

      const seen: string[] = [];
      server.use(serveBatches(() => false, (first) => seen.push(first)));
      await stepFetchTopicIds('', makeCtx().ctx, { background: true });

      expect(seen[0]).toBe('aaa 000');
      expect(await getSetting(TOPIC_CURSOR_KEY)).toBe(cursor);
    });

    it('a list within one batch never writes the cursor row', async () => {
      await seedInterest('I follow racing', ['formula 1']);

      await stepFetchTopicIds('', makeCtx().ctx);

      expect(await getSetting(TOPIC_CURSOR_KEY)).toBeNull();
    });
  });

  it('never sends a negative or suppressed topic', async () => {
    await seedInterest('I follow racing', ['kept', { text: 'unwanted', weight: -1 }]);
    const sent = recordOps();

    await stepFetchTopicIds('', makeCtx().ctx);

    const [{ variables }] = await sent.named('GetArticleIdsForPersona');
    expect(variables.query.topics.map((t: { text: string }) => t.text)).toEqual(['kept']);
  });

  it('always sends a GLOBAL headline scope, even for a device with no places', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    const sent = recordOps();

    await stepFetchTopicIds('', makeCtx().ctx);

    const [{ variables }] = await sent.named('GetArticleIdsForPersona');
    expect(variables.query.topHeadlines.scopes).toEqual([{ scope: 'GLOBAL', countryCode: null }]);
    expect(variables.query.topHeadlines.limitPerScope).toBeGreaterThan(0);
  });

  it('sends one COUNTRY scope per place country, heaviest location first, then GLOBAL last', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    await seedLocation('FR', 0.4, 'work');
    await seedLocation('NL', 0.9, 'home');
    await seedLocation('DE', 0.6, 'travel');
    const sent = recordOps();

    await stepFetchTopicIds('', makeCtx().ctx);

    const [{ variables }] = await sent.named('GetArticleIdsForPersona');
    const scopes = variables.query.topHeadlines.scopes as { scope: string; countryCode: string | null }[];
    expect(scopes.map((s) => `${s.scope}:${s.countryCode}`)).toEqual([
      'COUNTRY:NL',
      'COUNTRY:DE',
      'COUNTRY:FR',
      'GLOBAL:null',
    ]);
  });

  it('sends no per-scope limit when no depth is overridden', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    await seedLocation('NL', 0.9);
    const sent = recordOps();

    await stepFetchTopicIds('', makeCtx().ctx);

    const [{ variables }] = await sent.named('GetArticleIdsForPersona');
    for (const scope of variables.query.topHeadlines.scopes) expect(scope).not.toHaveProperty('limit');
  });

  it('ignores a stored headline depth override while the depth feature is off', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    await setHeadlineDepth('GLOBAL', 3);
    const sent = recordOps();

    await stepFetchTopicIds('', makeCtx().ctx);

    const [{ variables }] = await sent.named('GetArticleIdsForPersona');
    expect(variables.query.topHeadlines.scopes).toEqual([{ scope: 'GLOBAL', countryCode: null }]);
  });

  it('flags a followed-story-only text strictMatch, and leaves a text shared with an interest loose', async () => {
    await seedInterest('I follow gaza news', ['Gaza ceasefire']);
    await seedTracked('gaza  ceasefire');
    await seedTracked('Titan sub inquiry');
    const sent = recordOps();

    await stepFetchTopicIds('', makeCtx().ctx);

    const [{ variables }] = await sent.named('GetArticleIdsForPersona');
    const byText = new Map<string, Record<string, unknown>>(
      variables.query.topics.map((t: { text: string }) => [t.text, t]),
    );
    expect(byText.get('Titan sub inquiry')).toMatchObject({ strictMatch: true });
    // the shared text is sent once and loose: the key is absent, not false
    const shared = variables.query.topics.filter((t: { text: string }) => /gaza/i.test(t.text));
    expect(shared).toHaveLength(1);
    expect(shared[0]).not.toHaveProperty('strictMatch');
  });

  it('omits strictMatch entirely when nothing is followed', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    const sent = recordOps();

    await stepFetchTopicIds('', makeCtx().ctx);

    const [{ variables }] = await sent.named('GetArticleIdsForPersona');
    for (const t of variables.query.topics) expect(t).not.toHaveProperty('strictMatch');
  });
});

describe('what comes back from the persona response', () => {
  it('inverts the response into per-article matched topics, texts and stable cluster ids', async () => {
    const { topics } = await seedInterest('I follow racing', ['formula 1', 'motogp']);
    server.use(
      servePersona({
        topics: { 'formula 1': ['p1', 'p2'], motogp: ['p2', 'p3'] },
        headlines: [{ scope: 'GLOBAL', ids: ['h1'] }],
      }),
    );

    const out = await stepFetchTopicIds('', makeCtx().ctx);

    const f1 = topics.find((t) => t.text === 'formula 1')!.id;
    const moto = topics.find((t) => t.text === 'motogp')!.id;
    expect(out.personaMeta!.matchedTopics.get('p2')).toEqual([
      { topicId: f1, text: 'formula 1', vectorScore: 0.8, stableClusterId: 'stable-p2' },
      { topicId: moto, text: 'motogp', vectorScore: 0.8, stableClusterId: 'stable-p2' },
    ]);
    expect(out.articleToTopicTexts.get('p2')).toEqual(['formula 1', 'motogp']);
    expect(out.personaMeta!.stableClusterId!.get('p3')).toBe('stable-p3');
    // a headline match is a synthetic topic with no id and no score
    expect(out.personaMeta!.matchedTopics.get('h1')).toEqual([
      { topicId: null, text: 'top headline · global', vectorScore: null, stableClusterId: 'stable-h1' },
    ]);
    expect(out.personaMeta!.headlineScope!.get('h1')).toBe('GLOBAL');
  });

  it('records the COUNTRY scope and its uppercased country beside the label', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    await seedLocation('NL', 0.9);
    server.use(servePersona({ headlines: [{ scope: 'COUNTRY', countryCode: 'NL', ids: ['n1'] }] }));

    const out = await stepFetchTopicIds('', makeCtx().ctx);

    expect(out.personaMeta!.headlineScope!.get('n1')).toBe('COUNTRY');
    expect(out.personaMeta!.headlineCountryCode!.get('n1')).toBe('NL');
  });

  it('an article in GLOBAL first and a COUNTRY scope second keeps the GLOBAL label and no country', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    await seedLocation('NL', 0.9);
    server.use(
      servePersona({
        headlines: [
          { scope: 'GLOBAL', ids: ['both'] },
          { scope: 'COUNTRY', countryCode: 'NL', ids: ['both'] },
        ],
      }),
    );

    const out = await stepFetchTopicIds('', makeCtx().ctx);

    expect(out.personaMeta!.headlineScope!.get('both')).toBe('GLOBAL');
    expect(out.personaMeta!.headlineCountryCode!.has('both')).toBe(false);
  });
});

describe('the order of serverArticleIds decides what the daily cap clips (billing guarantee)', () => {
  // Topics are charged first and the cap clips headlines, because the server truncates in pure
  // request order. Swapping the two loops in fetchTopicIdsPersona fails both tests below.
  it('lists every topic-matched id before every headline id', async () => {
    await seedInterest('I follow racing', ['formula 1', 'motogp']);
    await seedLocation('NL', 0.9);
    server.use(
      servePersona({
        topics: { 'formula 1': ['t1', 't2'], motogp: ['t3'] },
        headlines: [
          { scope: 'COUNTRY', countryCode: 'NL', ids: ['h1', 'h2'] },
          { scope: 'GLOBAL', ids: ['h3'] },
        ],
      }),
    );

    const out = await stepFetchTopicIds('', makeCtx().ctx);

    expect(out.serverArticleIds).toEqual(['t1', 't2', 't3', 'h1', 'h2', 'h3']);
  });

  it('keeps an article matched by a topic AND a headline in its topic position', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    server.use(
      servePersona({
        topics: { 'formula 1': ['t1', 'shared'] },
        headlines: [{ scope: 'GLOBAL', ids: ['h1', 'shared'] }],
      }),
    );

    const out = await stepFetchTopicIds('', makeCtx().ctx);

    expect(out.serverArticleIds).toEqual(['t1', 'shared', 'h1']);
    // and it keeps the topic-retrieved match first
    expect(out.personaMeta!.matchedTopics.get('shared')!.map((m) => m.topicId === null)).toEqual([false, true]);
  });
});

describe('a resolver error inside a 200', () => {
  it('cancels instead of retrying when the run is aborted while the request fails', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    const t = makeCtx();
    let calls = 0;
    server.use(
      graphql.query('GetArticleIdsForPersona', () => {
        calls += 1;
        t.abort();
        return HttpResponse.json({
          data: null,
          errors: [{ message: 'resolver timed out', extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
        });
      }),
    );

    await expect(stepFetchTopicIds('', t.ctx)).rejects.toMatchObject({ name: 'AbortError', message: 'aborted' });

    expect(calls).toBe(1);
  });

  it('is retried once and then surfaces (two requests in all)', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    let calls = 0;
    server.use(
      graphql.query('GetArticleIdsForPersona', () => {
        calls += 1;
        return HttpResponse.json({
          data: null,
          errors: [{ message: 'resolver timed out', extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
        });
      }),
    );

    await expect(stepFetchTopicIds('', makeCtx().ctx)).rejects.toBeDefined();

    expect(calls).toBe(2);
  });
});
