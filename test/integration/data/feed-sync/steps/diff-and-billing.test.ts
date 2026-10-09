// stepDiff and the billing partition (computeFreeTopicTexts, partitionStoryIds) against the real
// services and the in-memory DB. Rows already on the device come from a first real sync, and the
// terminal statuses from the status writers. Replaces the stepDiff, computeFreeTopicTexts,
// partitionStoryIds and "stepDiff - billing partition" blocks of
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
import { batchMarkExcluded } from '@/lib/database/services/article-suggestion-service';
import { batchMarkAlreadyRead } from '@/lib/feed-grouping/read-story-filter';
import {
  computeFreeTopicTexts,
  partitionStoryIds,
  stepDiff,
  stepFetchTopicIds,
} from '@/lib/scheduler/feed-sync/feed-sync-steps';
import { server } from '@/test/helpers';
import {
  cleanupFeedSync,
  fetchAndDiff,
  hydrate,
  makeCtx,
  markPersonaMigrated,
  resetFeedSyncMemory,
  rowsById,
  seedInterest,
  seedTracked,
  servePersona,
  serveHydrate,
} from './support';

beforeEach(resetFeedSyncMemory);
afterEach(cleanupFeedSync);

describe('stepDiff: what is new to this device', () => {
  it('returns the server ids the device does not hold, in server order', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    server.use(servePersona({ topics: { 'formula 1': ['n3', 'n1', 'n2'] } }), ...serveHydrate().handlers);
    const t = makeCtx();
    const first = await fetchAndDiff(t);
    expect(first.diff.missingIds).toEqual(['n3', 'n1', 'n2']);
    await hydrate(first.diff, t);

    server.use(servePersona({ topics: { 'formula 1': ['n3', 'n4', 'n1', 'n5'] } }));
    const second = await fetchAndDiff(t);

    expect(second.diff.missingIds).toEqual(['n4', 'n5']);
  });

  it('requests nothing again on a relaunch: every id is already local', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    server.use(servePersona({ topics: { 'formula 1': ['n1', 'n2'] } }), ...serveHydrate().handlers);
    const t = makeCtx();
    await hydrate((await fetchAndDiff(t)).diff, t);

    const { diff } = await fetchAndDiff(t);

    expect(diff.missingIds).toEqual([]);
    expect(diff.storyIds).toEqual([]);
    expect(diff.personaIds).toEqual([]);
  });

  it('does not request an id again once it is excluded or already read: terminal rows still count as held', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    server.use(servePersona({ topics: { 'formula 1': ['keep', 'gone', 'read'] } }), ...serveHydrate().handlers);
    const t = makeCtx();
    await hydrate((await fetchAndDiff(t)).diff, t);
    await batchMarkExcluded(['gone']);
    await batchMarkAlreadyRead(['read']);
    const rows = await rowsById();
    expect(rows.get('gone')!.status).toBe('excluded');
    expect(rows.get('read')!.status).toBe('already_read');

    const { diff } = await fetchAndDiff(t);

    expect(diff.missingIds).toEqual([]);
  });

  it('passes the server ids, the text map and the persona metadata through unchanged', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    server.use(servePersona({ topics: { 'formula 1': ['n1', 'n2'] }, headlines: [{ scope: 'GLOBAL', ids: ['h1'] }] }));
    const t = makeCtx();
    const fetched = await stepFetchTopicIds('', t.ctx);

    const diff = await stepDiff(fetched, t.ctx);

    expect(diff.serverArticleIds).toBe(fetched.serverArticleIds);
    expect(diff.articleToTopicTexts).toBe(fetched.articleToTopicTexts);
    expect(diff.personaMeta).toBe(fetched.personaMeta);
  });

  it('logs how many ids are missing', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    server.use(servePersona({ topics: { 'formula 1': ['n1', 'n2', 'n3'] } }));
    const t = makeCtx();

    await fetchAndDiff(t);

    expect(t.log).toHaveBeenCalledWith('3 missing ids to hydrate');
  });

  it('an already-aborted signal throws a cancellation', async () => {
    const t = makeCtx();
    t.abort();

    await expect(
      stepDiff({ serverArticleIds: [], articleToTopicTexts: new Map() }, t.ctx),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'aborted' });
  });
});

describe('stepDiff: the billing partition', () => {
  // formula 1 (interest) · titan inquiry (followed only) · gaza ceasefire (followed AND an interest)
  async function world() {
    await seedInterest('I follow racing and gaza', ['formula 1', 'Gaza Ceasefire']);
    await seedTracked('titan inquiry');
    await seedTracked('gaza  ceasefire'); // same NORMALIZED text as the interest above
  }

  it('sends an id matched ONLY by a followed story to the quota-free set', async () => {
    await world();
    server.use(servePersona({ topics: { 'titan inquiry': ['f1', 'f2'], 'formula 1': ['i1'] } }));

    const { diff } = await fetchAndDiff(makeCtx());

    expect(diff.storyIds).toEqual(['f1', 'f2']);
    expect(diff.personaIds).toEqual(['i1']);
  });

  it('meters an id matched by a followed story and an interest with the same normalized text', async () => {
    await world();
    server.use(
      servePersona({ topics: { 'gaza ceasefire': ['g1', 'g2'], 'titan inquiry': ['f1'] } }),
    );

    const { diff } = await fetchAndDiff(makeCtx());

    expect(diff.storyIds).toEqual(['f1']);
    expect(diff.personaIds!.sort()).toEqual(['g1', 'g2']);
  });

  it('meters an id matched by a followed story and a different interest', async () => {
    await world();
    server.use(servePersona({ topics: { 'titan inquiry': ['both', 'free'], 'formula 1': ['both'] } }));

    const { diff } = await fetchAndDiff(makeCtx());

    expect(diff.storyIds).toEqual(['free']);
    expect(diff.personaIds).toEqual(['both']);
  });

  it('meters a headline-matched id even when its only topic is a followed story', async () => {
    await world();
    server.use(
      servePersona({
        topics: { 'titan inquiry': ['also-headline', 'free'] },
        headlines: [{ scope: 'GLOBAL', ids: ['also-headline'] }],
      }),
    );

    const { diff } = await fetchAndDiff(makeCtx());

    expect(diff.storyIds).toEqual(['free']);
    expect(diff.personaIds).toEqual(['also-headline']);
  });

  it('keeps the two sets disjoint and their union equal to the missing ids', async () => {
    await world();
    server.use(
      servePersona({
        topics: { 'titan inquiry': ['f1', 'f2', 'm1'], 'formula 1': ['i1', 'm1'], 'gaza ceasefire': ['g1'] },
        headlines: [{ scope: 'GLOBAL', ids: ['h1', 'f2'] }],
      }),
    );

    const { diff } = await fetchAndDiff(makeCtx());

    const story = diff.storyIds!;
    const persona = diff.personaIds!;
    expect(story.filter((id) => persona.includes(id))).toEqual([]);
    expect([...story, ...persona].sort()).toEqual([...diff.missingIds].sort());
    expect(story).toEqual(['f1']);
  });

  it('partitions only what is new: a followed-story id already on the device is in neither set', async () => {
    await world();
    server.use(servePersona({ topics: { 'titan inquiry': ['held', 'fresh'] } }), ...serveHydrate().handlers);
    const t = makeCtx();
    await hydrate((await fetchAndDiff(t)).diff, t);
    server.use(servePersona({ topics: { 'titan inquiry': ['held', 'fresh', 'later'] } }));

    const { diff } = await fetchAndDiff(t);

    expect(diff.missingIds).toEqual(['later']);
    expect(diff.storyIds).toEqual(['later']);
    expect(diff.personaIds).toEqual([]);
  });

  it('meters everything on the legacy path, which has no followed-story topics', async () => {
    await markPersonaMigrated();
    await addFact('I follow racing', { topics: ['alpha'] });
    const { diff } = await fetchAndDiff(makeCtx());

    expect(diff.storyIds).toEqual([]);
    expect(diff.personaIds).toEqual(diff.missingIds);
    expect(diff.missingIds.length).toBeGreaterThan(0);
  });
});

describe('computeFreeTopicTexts', () => {
  it('returns the tracked topic texts, normalized', () => {
    const free = computeFreeTopicTexts([
      { text: '  Gaza   Ceasefire ', provenance: 'tracked' },
      { text: 'formula 1', provenance: 'llm' },
    ]);

    expect(free).toEqual(new Set(['gaza ceasefire']));
  });

  it('subtracts any text a non-tracked topic also carries, whatever its provenance', () => {
    for (const provenance of ['llm', 'user', 'feedback', 'combo', 'interest']) {
      const free = computeFreeTopicTexts([
        { text: 'gaza ceasefire', provenance: 'tracked' },
        { text: 'Gaza Ceasefire', provenance },
      ]);
      expect(free).toEqual(new Set());
    }
  });

  it('ignores blank texts and is empty when nothing is tracked', () => {
    expect(computeFreeTopicTexts([{ text: '   ', provenance: 'tracked' }])).toEqual(new Set());
    expect(computeFreeTopicTexts([{ text: 'formula 1', provenance: 'llm' }])).toEqual(new Set());
    expect(computeFreeTopicTexts([])).toEqual(new Set());
  });
});

describe('partitionStoryIds', () => {
  const free = new Set(['gaza ceasefire', 'titan inquiry']);

  it('is free only when EVERY matched text is a free text', () => {
    const texts = new Map([
      ['only-free', ['Gaza Ceasefire']],
      ['two-free', ['gaza ceasefire', 'titan  inquiry']],
      ['mixed', ['gaza ceasefire', 'formula 1']],
      ['not-free', ['formula 1']],
    ]);

    const out = partitionStoryIds(['only-free', 'two-free', 'mixed', 'not-free'], texts, free);

    expect(out.storyIds).toEqual(['only-free', 'two-free']);
    expect(out.personaIds).toEqual(['mixed', 'not-free']);
  });

  it('meters a headline-scope id and an id with no matched text', () => {
    const texts = new Map([['h', ['gaza ceasefire']]]);

    const out = partitionStoryIds(['h', 'bare'], texts, free, new Map([['h', 'GLOBAL']]));

    expect(out).toEqual({ storyIds: [], personaIds: ['h', 'bare'] });
  });

  it('meters everything when there are no free texts, or the set is absent', () => {
    const texts = new Map([['a', ['gaza ceasefire']]]);

    expect(partitionStoryIds(['a'], texts, new Set())).toEqual({ storyIds: [], personaIds: ['a'] });
    expect(partitionStoryIds(['a'], texts, undefined)).toEqual({ storyIds: [], personaIds: ['a'] });
  });

  it('keeps the two outputs disjoint and drops nothing', () => {
    const texts = new Map([
      ['a', ['gaza ceasefire']],
      ['b', ['formula 1']],
      ['c', ['titan inquiry']],
    ]);
    const input = ['a', 'b', 'c', 'd'];

    const { storyIds, personaIds } = partitionStoryIds(input, texts, free);

    expect(storyIds.filter((id) => personaIds.includes(id))).toEqual([]);
    expect([...storyIds, ...personaIds].sort()).toEqual([...input].sort());
  });
});
