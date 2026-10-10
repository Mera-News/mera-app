// article_suggestions lifecycle: delete by id, the 48h sweep, clear, prune by active topics, and the
// dead-topic purge. The purge is driven through its real callers too (deleteFact, the topic undo
// window, the commit), because they are what hand it the liveness set: a staged delete must still
// count as alive or an undo cannot bring the suggestions back. Replaces
// lib/database/services/__tests__/article-suggestion-purge-dead-topics.test.ts and the delete, clear
// and prune blocks of article-suggestion-service.test.ts.
import { addFact, deleteFact, removeFactMetadataTopics } from '@/lib/database/services/fact-service';
import {
  clearSuggestions,
  deleteOldSuggestions,
  deleteSuggestionByServerId,
  deleteSuggestionsByServerIds,
  loadFeedMetadata,
  persistFeedMetadata,
  pruneOrphanedSuggestions,
  purgeSuggestionsForDeadTopics,
} from '@/lib/database/services/article-suggestion-lifecycle';
import {
  __resetPendingForTests,
  deleteTopicWithDecline,
  flushPendingDeletes,
  undoPendingDelete,
} from '@/lib/database/services/topic-decline-service';
import { getAllTopicIds, suppress } from '@/lib/database/services/topic-service';
import database from '@/lib/database';
import logger from '@/lib/logger';
import {
  DAY,
  HOUR,
  T0,
  allLinks,
  article,
  bareLink,
  failNextQuery,
  factsOf,
  freezeClock,
  idsInDb,
  interest,
  matched,
  seed,
  seedLegacy,
  toAlreadyRead,
  toComplete,
  toExcluded,
  toReasonSkipped,
} from './support';

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

beforeEach(() => freezeClock());
afterEach(() => {
  __resetPendingForTests();
  jest.restoreAllMocks();
});

describe('deleteSuggestionsByServerIds', () => {
  it('is 0 for no ids or ids that are not there, and touches nothing', async () => {
    await seed([article('a1')]);

    expect(await deleteSuggestionsByServerIds([])).toBe(0);
    expect(await deleteSuggestionsByServerIds(['nonexistent'])).toBe(0);
    expect(await idsInDb()).toEqual(['a1']);
  });

  it('deletes the rows and their fact links, and leaves every other row and link', async () => {
    const A = await interest('fact A', ['x']);
    await seed(['a1', 'a2', 'a3'].map((id) => article(id)), {
      topics: { a1: [matched(A.topics[0])], a2: [matched(A.topics[0])], a3: [matched(A.topics[0])] },
    });

    const count = await deleteSuggestionsByServerIds(['a1', 'a2', 'missing']);

    expect(count).toBe(2);
    expect(await idsInDb()).toEqual(['a3']);
    expect((await allLinks()).map((l) => l.articleSuggestionId)).toEqual(['a3']);
  });

  it('deleteSuggestionByServerId says whether the row existed', async () => {
    await seed([article('a1')]);

    expect(await deleteSuggestionByServerId('a1')).toBe(true);
    expect(await deleteSuggestionByServerId('a1')).toBe(false);
    expect(await idsInDb()).toEqual([]);
  });
});

// The TTL sweep (data-cleanup passes now - 48h). The fact page counts excluded, already_read and
// below-gate rows inside 48h in its Not impactful list, so a sweep that drops them early silently
// empties that list.
describe('deleteOldSuggestions(cutoff)', () => {
  const cutoff = T0 - 2 * DAY;
  const at = (ms: number) => jest.setSystemTime(ms);

  async function seedAges() {
    const A = await interest('fact A', ['x']);
    const linked = { topics: Object.fromEntries(['old', 'inside', 'atCutoff'].map((id) => [id, [matched(A.topics[0])]])) };
    at(cutoff - 25 * HOUR);
    await seed(['old', 'oldExcluded'].map((id) => article(id)), linked);
    await toExcluded('oldExcluded');
    at(cutoff);
    await seed([article('atCutoff')], linked);
    at(cutoff + HOUR);
    await seed(['inside', 'insideExcluded', 'insideRead', 'insideSkipped', 'insideBelowGate'].map((id) => article(id)), linked);
    await toExcluded('insideExcluded');
    await toAlreadyRead('insideRead');
    await toComplete('insideSkipped', 0.8);
    await toReasonSkipped('insideSkipped');
    await toComplete('insideBelowGate', 0.2);
    at(T0);
  }

  it('deletes rows created before the cutoff, terminal or not, with their links', async () => {
    await seedAges();

    const count = await deleteOldSuggestions(cutoff);

    expect(count).toBe(2);
    expect(await idsInDb()).not.toContain('old');
    expect(await idsInDb()).not.toContain('oldExcluded');
    expect((await allLinks()).map((l) => l.articleSuggestionId)).not.toContain('old');
  });

  it('keeps every row inside the window, terminal statuses included, and a row created exactly at the cutoff', async () => {
    await seedAges();

    await deleteOldSuggestions(cutoff);

    expect(await idsInDb()).toEqual([
      'atCutoff',
      'inside',
      'insideBelowGate',
      'insideExcluded',
      'insideRead',
      'insideSkipped',
    ]);
    expect(await factsOf('inside')).toHaveLength(1);
    expect(await factsOf('atCutoff')).toHaveLength(1);
  });

  it('is 0 and deletes nothing when everything is inside the window', async () => {
    await seed([article('a1')]);

    expect(await deleteOldSuggestions(T0 - 2 * DAY)).toBe(0);
    expect(await deleteOldSuggestions(0)).toBe(0);
    expect(await idsInDb()).toEqual(['a1']);
  });
});

describe('clearSuggestions', () => {
  it('deletes every row and link and the cold-start feed metadata', async () => {
    const A = await interest('fact A', ['x']);
    await seed(['a1', 'a2'].map((id) => article(id)), { topics: { a1: [matched(A.topics[0])] } });
    await persistFeedMetadata({ articleCount: 10, relevantArticleCount: 4, hasGeneratedTopics: true });

    await clearSuggestions();

    expect(await idsInDb()).toEqual([]);
    expect(await allLinks()).toEqual([]);
    expect(await loadFeedMetadata()).toBeNull();
  });

  it('still clears the feed metadata when there is nothing to delete', async () => {
    await persistFeedMetadata({ articleCount: 1, relevantArticleCount: 1, hasGeneratedTopics: false });

    await clearSuggestions();

    expect(await loadFeedMetadata()).toBeNull();
  });

  it('clears join rows even when no suggestion is left for them', async () => {
    // Every service that deletes a suggestion (delete by id, the 48h sweep, clear, prune, the dead-topic
    // purge) destroys its joins in the same batch; deleteFact removes the fact, not the join. So a join with
    // no suggestion is a bare row.
    await bareLink('ghost', 'fact-1');

    await clearSuggestions();

    expect(await allLinks()).toEqual([]);
  });
});

describe('pruneOrphanedSuggestions', () => {
  it('clears everything and returns -1 when no fact names a topic', async () => {
    await seed([article('a1')]);
    await addFact('a fact with no topics');
    await persistFeedMetadata({ articleCount: 3, relevantArticleCount: 1, hasGeneratedTopics: true });

    expect(await pruneOrphanedSuggestions()).toBe(-1);

    expect(await idsInDb()).toEqual([]);
    expect(await loadFeedMetadata()).toBeNull();
  });

  it('clears everything and returns -1 when there is no fact at all', async () => {
    await seed([article('a1')]);
    expect(await pruneOrphanedSuggestions()).toBe(-1);
    expect(await idsInDb()).toEqual([]);
  });

  it('is 0 and writes nothing when every row still matches an active topic', async () => {
    await interest('fact A', ['berlin']);
    await seedLegacy([article('a1')], { a1: ['berlin'] });
    const spy = jest.spyOn(database, 'write');

    expect(await pruneOrphanedSuggestions()).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('deletes rows whose topics are all gone (and their links), and keeps partial overlaps and rows with no topics', async () => {
    const F = await interest('fact F', ['london', 'berlin']);
    await seedLegacy(['gone', 'live', 'partial', 'notopics'].map((id) => article(id)), {
      gone: ['berlin'],
      live: ['london'],
      partial: ['berlin', 'london'],
      notopics: [],
    });
    await removeFactMetadataTopics(F.fact.id, ['berlin']);
    expect(await factsOf('gone')).toEqual([F.fact.id]);

    expect(await pruneOrphanedSuggestions()).toBe(1);

    expect(await idsInDb()).toEqual(['live', 'notopics', 'partial']);
    expect(await factsOf('gone')).toEqual([]);
  });
});

describe('purgeSuggestionsForDeadTopics', () => {
  const one = (topicId: string | null, text = 'topic') => ({ topicId, text });

  it('destroys a row whose every matched topic is gone', async () => {
    await seed([article('dead')], { topics: { dead: [one('t-gone', 'nfl')] } });

    expect(await purgeSuggestionsForDeadTopics(new Set(['t-live']))).toBe(1);
    expect(await idsInDb()).toEqual([]);
  });

  it('KEEPS a row while even one matched topic still exists', async () => {
    await seed([article('mixed')], { topics: { mixed: [one('t-gone', 'nfl'), one('t-live', 'ai policy')] } });

    expect(await purgeSuggestionsForDeadTopics(new Set(['t-live']))).toBe(0);
    expect(await idsInDb()).toEqual(['mixed']);
  });

  it('KEEPS a row with no topic evidence at all: legacy null, empty list, synthetic headline entry', async () => {
    await seedLegacy([article('legacy')], {});
    await seed([article('empty'), article('synthetic')], { topics: { synthetic: [one(null, 'headline match')] } });

    expect(await purgeSuggestionsForDeadTopics(new Set())).toBe(0);
    expect(await idsInDb()).toEqual(['empty', 'legacy', 'synthetic']);
  });

  it('KEEPS a top-headline row even when its topics are gone: it has a scope section', async () => {
    await seed([article('headline')], { topics: { headline: [one('t-gone', 'x')] }, headline: { headline: 'COUNTRY' } });

    expect(await purgeSuggestionsForDeadTopics(new Set())).toBe(0);
    expect(await idsInDb()).toEqual(['headline']);
  });

  it('destroys the row and its fact links together, leaving other rows and links intact', async () => {
    const A = await interest('fact A', ['x']);
    const B = await interest('fact B', ['y']);
    await seed(['dead', 'kept'].map((id) => article(id)), {
      topics: { dead: [matched(A.topics[0])], kept: [matched(B.topics[0])] },
    });

    expect(await purgeSuggestionsForDeadTopics(new Set([B.topics[0].id]))).toBe(1);

    expect(await idsInDb()).toEqual(['kept']);
    expect((await allLinks()).map((l) => l.articleSuggestionId)).toEqual(['kept']);
  });

  it('purges terminal rows too: they are stale once their topic is gone', async () => {
    await seed(['read'].map((id) => article(id)), { topics: { read: [one('t-gone')] } });
    await toAlreadyRead('read');

    expect(await purgeSuggestionsForDeadTopics(new Set())).toBe(1);
  });

  it('is 0 and writes nothing when nothing qualifies', async () => {
    const spy = jest.spyOn(database, 'write');

    expect(await purgeSuggestionsForDeadTopics(new Set(['t-live']))).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('never throws: a read failure must not fail the committed fact deletion', async () => {
    failNextQuery('article_suggestions');

    await expect(purgeSuggestionsForDeadTopics(new Set())).resolves.toBe(0);
    expect(logger.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'article-suggestion', method: 'purgeSuggestionsForDeadTopics' },
    });
  });
});

// The liveness set is `getAllTopicIds()`: every topic on the device, retired, suppressed and STAGED
// ones included. Deleting a fact removes its topics and purges what they retrieved; another fact's
// topic that is only staged for deletion (inside its undo window) must not be treated as dead.
describe('the purge through its callers', () => {
  async function twoFacts() {
    const A = await interest('fact A', ['x']);
    const B = await interest('fact B', ['y']);
    await seed(['rowA', 'rowB'].map((id) => article(id)), {
      topics: { rowA: [matched(A.topics[0])], rowB: [matched(B.topics[0])] },
    });
    return { A, B };
  }

  it('deleteFact destroys what only its own topics retrieved, and nothing else', async () => {
    const { B } = await twoFacts();

    await deleteFact(B.fact.id);

    expect(await idsInDb()).toEqual(['rowA']);
    expect((await allLinks()).map((l) => l.articleSuggestionId)).toEqual(['rowA']);
  });

  it('a STAGED topic still counts as alive: its rows survive another fact\'s deletion', async () => {
    const { A, B } = await twoFacts();
    await deleteTopicWithDecline(A.topics[0].id, { undoWindowMs: 60_000 });

    await deleteFact(B.fact.id);

    expect(await idsInDb()).toEqual(['rowA']);
    expect((await getAllTopicIds()).has(A.topics[0].id)).toBe(true);
  });

  it('an undo inside the window brings the topic back with its rows intact', async () => {
    const { A, B } = await twoFacts();
    await deleteTopicWithDecline(A.topics[0].id, { undoWindowMs: 60_000 });
    await deleteFact(B.fact.id);

    expect(await undoPendingDelete(A.topics[0].id)).toBe(true);

    expect(await idsInDb()).toEqual(['rowA']);
  });

  it('the commit that follows the window destroys the topic and purges its rows', async () => {
    const { A } = await twoFacts();
    await deleteTopicWithDecline(A.topics[0].id, { undoWindowMs: 60_000 });

    expect(await flushPendingDeletes()).toBe(1);

    expect(await idsInDb()).toEqual(['rowB']);
  });

  it('a suppressed topic still exists, so its rows are stale, not orphaned', async () => {
    const { A, B } = await twoFacts();
    await suppress(A.topics[0].id);

    await deleteFact(B.fact.id);

    expect(await idsInDb()).toEqual(['rowA']);
  });

  it('keeps a row matched by one topic of a deleted fact and one of a live fact', async () => {
    const A = await interest('fact A', ['x']);
    const B = await interest('fact B', ['y']);
    await seed([article('both')], { topics: { both: [matched(A.topics[0]), matched(B.topics[0])] } });

    await deleteFact(B.fact.id);

    expect(await idsInDb()).toEqual(['both']);
  });
});
