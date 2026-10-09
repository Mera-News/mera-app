// fact-service on the in-memory database: CRUD, what a delete cascades, the metadata topic list's
// append / prune, the topics_status transitions and the rescue sweep, replaceFact's one batch, and
// the live observables the fact card renders.
//
// Replaces:
//   fact-service.test.ts (41 `it`): addFact (5); updateFact (6); deleteFact (2); getFacts (4);
//     getFactsForTopicTexts (5); markOrphanedFactsAsFailed (8); hasAnyFacts (4); appendFactMetadataTopics (7)
//   fact-service-topics-status.test.ts (14 `it`): addFact topicsStatus opt-in (2); the rescue sweep
//     (5); replaceFact (4); removeFactMetadataTopics (2); getTopicsStatus (1)
//
// Not carried over: "getFactsForTopicTexts with [] does not even query the DB" and "hasAnyFacts counts
// in SQL rather than materialising rows" assert how a mock was called, not what a caller can see;
// "deleteFact calls destroyCascade once" is replaced by what the cascade leaves.
import {
  PENDING_TOPICS_STALE_MS,
  addFact,
  appendFactMetadataTopics,
  deleteFact,
  getFactIdsWithoutTopicStatus,
  getFactSectionSnapshots,
  getFacts,
  getFactsForTopicTexts,
  getPendingTopicFactIds,
  getTopicsStatus,
  hasAnyFacts,
  markOrphanedFactsAsFailed,
  markTopicsReviewed,
  observeFact,
  observeFacts,
  observeTopicsStatus,
  removeFactMetadataTopics,
  replaceFact,
  updateFact,
} from '@/lib/database/services/fact-service';
import {
  beginTopicGeneration,
  failTopicGeneration,
  markTopicGenerationSettled,
} from '@/lib/database/services/topic-generation-status-service';
import { useFakeClock, useFakeClock as freezeClockAt } from '@/test/helpers'; // aliased: a use* name inside a plain function trips react-hooks/rules-of-hooks

import {
  cleanupTopics,
  collect,
  countRows,
  failBatchWhere,
  metadataOf,
  metadataTopics,
  persistedTopicsStatus,
  resetTopicsMemory,
  seedFact,
  seedSuggestion,
  suggestionIds,
  until,
} from './support';

beforeEach(resetTopicsMemory);
afterEach(cleanupTopics);

const T0 = Date.parse('2026-10-09T10:00:00Z');
const factOf = async (id: string) => (await getFacts()).find((f) => f.id === id)!;

describe('addFact', () => {
  it('creates a fact with ISO date strings and nothing else it was not given', async () => {
    const out = await addFact('I am a developer');

    expect(out).toMatchObject({ statement: 'I am a developer', weight: null, topicsStatus: null, topicsUpdatedAt: null });
    expect(out.metadata).toBeUndefined();
    expect(out.questionnaireLevel).toBeUndefined();
    expect(new Date(out.createdAt).toISOString()).toBe(out.createdAt);
    expect(new Date(out.updatedAt).toISOString()).toBe(out.updatedAt);
    expect((await getFacts()).map((f) => f.id)).toEqual([out.id]);
  });

  it('stores the metadata and the questionnaire fields it is given', async () => {
    const out = await addFact('I live in Berlin', { topics: ['coding'] }, { level: 2, levelCategory: 'Core', attribute: 'location: neighborhood' });

    expect(out.metadata).toEqual({ topics: ['coding'] });
    expect(out).toMatchObject({
      questionnaireLevel: 2,
      questionnaireLevelCategory: 'Core',
      questionnaireAttribute: 'location: neighborhood',
    });
    expect(await factOf(out.id)).toMatchObject({ questionnaireLevel: 2, questionnaireAttribute: 'location: neighborhood' });
  });

  it('leaves topics_status NULL by default, and stamps pending (with its time) only when the caller is enqueuing generation', async () => {
    const plain = await addFact('I live in Rotterdam');
    const queued = await addFact('I live in Utrecht', undefined, undefined, { topicsStatus: 'pending' });

    expect(await getTopicsStatus(plain.id)).toBeNull();
    expect(await getTopicsStatus(queued.id)).toBe('pending');
    expect((await factOf(plain.id)).topicsUpdatedAt).toBeNull();
    expect((await factOf(queued.id)).topicsUpdatedAt).not.toBeNull();
  });
});

describe('updateFact', () => {
  it('writes a new statement and keeps the metadata', async () => {
    const f = await addFact('old', { topics: ['original'] });

    const out = await updateFact(f.id, { statement: 'new statement' });

    expect(out).toMatchObject({ id: f.id, statement: 'new statement', metadata: { topics: ['original'] } });
    expect(await factOf(f.id)).toMatchObject({ statement: 'new statement', metadata: { topics: ['original'] } });
  });

  it('writes new metadata and keeps the statement', async () => {
    const f = await addFact('keep me', { topics: ['original'] });

    await updateFact(f.id, { metadata: { topics: ['updated'] } });

    expect(await factOf(f.id)).toMatchObject({ statement: 'keep me', metadata: { topics: ['updated'] } });
  });

  it('treats an explicit undefined metadata as "keep what is there"', async () => {
    const f = await addFact('s', { topics: ['x'] });

    await updateFact(f.id, { metadata: undefined });

    expect((await factOf(f.id)).metadata).toEqual({ topics: ['x'] });
  });

  it('rejects for a fact that does not exist', async () => {
    await expect(updateFact('nonexistent', { statement: 'x' })).rejects.toThrow(/not found/i);
  });
});

describe('deleteFact', () => {
  it('cascades the fact\'s topics (and only those), then purges the suggestions only they retrieved', async () => {
    const doomed = await seedFact('Follows chess', ['Chess openings']);
    const kept = await seedFact('Follows cycling', ['Cycling']);
    await seedSuggestion('s-doomed', doomed.topics[0]);
    await seedSuggestion('s-kept', kept.topics[0]);

    await deleteFact(doomed.fact.id);

    expect((await getFacts()).map((f) => f.id)).toEqual([kept.fact.id]);
    expect(await countRows('topics')).toBe(1);
    expect(await suggestionIds()).toEqual(['s-kept']);
  });

  it('rejects for a fact that does not exist', async () => {
    await expect(deleteFact('ghost')).rejects.toThrow(/not found/i);
  });
});

describe('getFacts', () => {
  it('is empty for an empty table, and lists facts newest first', async () => {
    expect(await getFacts()).toEqual([]);
    useFakeClock(T0);
    const a = await addFact('fact one');
    jest.setSystemTime(T0 + 60_000);
    const b = await addFact('fact two');

    expect((await getFacts()).map((f) => f.id)).toEqual([b.id, a.id]);
  });
});

describe('getFactsForTopicTexts', () => {
  it('returns [] for no texts', async () => {
    await addFact('f', { topics: ['berlin'] });
    expect(await getFactsForTopicTexts([])).toEqual([]);
  });

  it('returns the facts whose metadata.topics overlap the given texts', async () => {
    const f1 = await addFact('one', { topics: ['berlin', 'germany'] });
    await addFact('two', { topics: ['paris', 'france'] });
    const f3 = await addFact('three', { topics: ['berlin'] });

    expect((await getFactsForTopicTexts(['berlin'])).map((f) => f.id).sort()).toEqual([f1.id, f3.id].sort());
    expect(await getFactsForTopicTexts(['tokyo'])).toEqual([]);
  });

  it('copes with a fact that has no metadata, and one with no topics array', async () => {
    await addFact('no metadata');
    await addFact('no topics', {});
    const withTopics = await addFact('with', { topics: ['coding'] });

    expect((await getFactsForTopicTexts(['coding'])).map((f) => f.id)).toEqual([withTopics.id]);
  });
});

describe('hasAnyFacts: the onboarding gate', () => {
  it('is false for an empty table and true once there is a fact', async () => {
    expect(await hasAnyFacts()).toBe(false);
    await addFact('one');
    expect(await hasAnyFacts()).toBe(true);
    await addFact('two');
    expect(await hasAnyFacts()).toBe(true);
  });
});

describe('getFactSectionSnapshots', () => {
  it('gives { id, weight, createdAtMs, statement, sectionTitle } per fact, in creation order', async () => {
    useFakeClock(T0);
    const a = await addFact('Fact A', { section_title: ['  Dutch life  '] });
    jest.setSystemTime(T0 + 60_000);
    // A string title is not what addFact's type allows, but old and restored rows can hold one.
    const b = await addFact('Fact B', { section_title: 'Cycling' } as unknown as Record<string, string[]>);
    jest.setSystemTime(T0 + 120_000);
    const c = await addFact('Fact C');

    const snaps = await getFactSectionSnapshots();

    expect(snaps.map((s) => [s.id, s.statement, s.weight, s.sectionTitle])).toEqual([
      [a.id, 'Fact A', null, 'Dutch life'],
      [b.id, 'Fact B', null, 'Cycling'],
      [c.id, 'Fact C', null, null],
    ]);
    const times = snaps.map((s) => s.createdAtMs);
    expect(times[0]).toBeGreaterThanOrEqual(T0);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(59_000);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(59_000);
  });

  it('is empty when there are no facts', async () => {
    expect(await getFactSectionSnapshots()).toEqual([]);
  });
});

describe('appendFactMetadataTopics', () => {
  it('APPENDS to the existing list rather than replacing it, preserving other metadata keys and the statement', async () => {
    const f = await addFact('Follows Indian cricket', { topics: ['India cricket news'], topicGenError: ['earlier failure'] });

    await appendFactMetadataTopics(f.id, ['Bengaluru cricket news']);

    expect(await factOf(f.id)).toMatchObject({
      statement: 'Follows Indian cricket',
      metadata: { topics: ['India cricket news', 'Bengaluru cricket news'], topicGenError: ['earlier failure'] },
    });
  });

  it('does not duplicate an existing topic (case-insensitive) and writes nothing then', async () => {
    const f = await addFact('s', { topics: ['India cricket news'] });
    const before = (await factOf(f.id)).updatedAt;

    await appendFactMetadataTopics(f.id, ['india CRICKET news']);

    expect((await factOf(f.id)).metadata).toEqual({ topics: ['India cricket news'] });
    expect((await factOf(f.id)).updatedAt).toBe(before);
  });

  it('seeds the list when the fact has no metadata at all', async () => {
    const f = await addFact('Follows Indian cricket');

    await appendFactMetadataTopics(f.id, ['Bengaluru cricket news']);

    expect((await factOf(f.id)).metadata).toEqual({ topics: ['Bengaluru cricket news'] });
  });

  it('is a no-op for an empty append, and drops blank texts', async () => {
    const f = await addFact('s', { topics: ['India cricket news'] });

    await appendFactMetadataTopics(f.id, []);
    await appendFactMetadataTopics(f.id, ['', '   ']);

    expect(await metadataTopics(f.id)).toEqual(['India cricket news']);
  });
});

describe('markTopicsReviewed', () => {
  it('stamps topicsReviewedAt and keeps the topics and the error marker; a missing fact is a no-op', async () => {
    const f = await addFact('s', { topics: ['x'], topicGenError: ['boom'] });

    await markTopicsReviewed(f.id, new Date('2026-10-09T10:00:00Z'));
    await expect(markTopicsReviewed('ghost')).resolves.toBeUndefined();

    expect(await metadataOf(f.id)).toEqual({
      topics: ['x'],
      topicGenError: ['boom'],
      topicsReviewedAt: ['2026-10-09T10:00:00.000Z'],
    });
  });
});

describe('removeFactMetadataTopics: the prune half of the pairing', () => {
  it('prunes by the normalised key and preserves the sibling metadata', async () => {
    const f = await addFact('s', { topics: ['Dutch  Politics', 'Cycling'], topicGenError: ['boom'] });

    await removeFactMetadataTopics(f.id, ['dutch politics']);

    expect(await metadataOf(f.id)).toEqual({ topics: ['Cycling'], topicGenError: ['boom'] });
  });

  it('is a no-op when nothing matches, for an empty set, and for a missing fact', async () => {
    const f = await addFact('s', { topics: ['Cycling'] });
    const before = (await factOf(f.id)).updatedAt;

    await removeFactMetadataTopics(f.id, ['nope']);
    await removeFactMetadataTopics(f.id, []);
    await expect(removeFactMetadataTopics('ghost', ['x'])).resolves.toBeUndefined();

    expect((await factOf(f.id)).updatedAt).toBe(before);
    expect(await metadataTopics(f.id)).toEqual(['Cycling']);
  });
});

describe('topics_status', () => {
  it('getTopicsStatus returns the stored status, and null for a missing fact or a fact with none', async () => {
    const f = await addFact('s', undefined, undefined, { topicsStatus: 'pending' });
    await failTopicGeneration(f.id, 'x');
    const plain = await addFact('plain');

    expect(await getTopicsStatus(f.id)).toBe('error');
    expect(await getTopicsStatus('ghost')).toBeNull();
    expect(await getTopicsStatus(plain.id)).toBeNull();
  });

  it('getPendingTopicFactIds lists pending facts oldest stamp first; getFactIdsWithoutTopicStatus lists the unasked', async () => {
    useFakeClock(T0);
    const older = await addFact('older');
    const newer = await addFact('newer');
    const never = await addFact('never asked');
    jest.setSystemTime(T0 + 1_000);
    await beginTopicGeneration([newer.id]);
    jest.setSystemTime(T0 + 2_000);
    await beginTopicGeneration([older.id]);
    jest.setSystemTime(T0 + 3_000);
    await markTopicGenerationSettled([never.id]);

    expect(await getPendingTopicFactIds()).toEqual([newer.id, older.id]);
    expect(await getFactIdsWithoutTopicStatus()).toEqual([]);
    const fresh = await addFact('fresh');
    expect(await getFactIdsWithoutTopicStatus()).toEqual([fresh.id]);
  });

  it('observeTopicsStatus: a NULL status reads "done", then follows pending, done, error, and ends at "gone" without completing', async () => {
    const f = await addFact('s');
    const feed = collect(observeTopicsStatus(f.id));
    await until(() => feed.seen.length === 1, 'first emission');

    await beginTopicGeneration([f.id]);
    await until(() => feed.seen.length === 2, 'pending');
    await markTopicGenerationSettled([f.id]);
    await until(() => feed.seen.length === 3, 'done');
    await failTopicGeneration(f.id, 'x');
    await until(() => feed.seen.length === 4, 'error');
    await deleteFact(f.id);
    await until(() => feed.seen.length === 5, 'gone');

    expect(feed.seen).toEqual(['done', 'pending', 'done', 'error', 'gone']);
    feed.stop();
  });

  it('observeFact emits the fact, re-emits on a status-only write, and emits null once it is gone; observeFacts follows the table', async () => {
    const f = await addFact('s');
    const one = collect(observeFact(f.id));
    const all = collect(observeFacts());
    await until(() => one.seen.length === 1 && all.seen.length === 1, 'first emissions');
    expect(one.seen[0]).toMatchObject({ id: f.id, topicsStatus: null });

    await beginTopicGeneration([f.id]);
    await until(() => one.seen.length === 2 && all.seen.length === 2, 'status-only write');
    expect(one.seen[1]).toMatchObject({ topicsStatus: 'pending' });
    expect(all.seen[1][0]).toMatchObject({ id: f.id, topicsStatus: 'pending' });

    await deleteFact(f.id);
    await until(() => one.seen.at(-1) === null, 'null after delete');
    expect(all.seen.at(-1)).toEqual([]);
    one.stop();
    all.stop();
  });
});

describe('the rescue sweep: markOrphanedFactsAsFailed', () => {
  const pendingFact = async (metadata?: Record<string, string[]>) => {
    freezeClockAt(T0);
    const f = await addFact('s', metadata, undefined, { topicsStatus: 'pending' });
    return f;
  };
  const later = (ms: number) => jest.setSystemTime(T0 + ms);

  it('returns 0 for an empty table', async () => {
    expect(await markOrphanedFactsAsFailed(new Set(), 'timed out')).toBe(0);
  });

  it('needs BOTH no live job AND staleness before it calls a pending fact dead', async () => {
    const f = await pendingFact({});
    later(60_000); // fresh: a fact enqueued moments ago loses no race against this read

    expect(await markOrphanedFactsAsFailed(new Set(), 'dead')).toBe(0);
    expect(await getTopicsStatus(f.id)).toBe('pending');
  });

  it('leaves a pending fact alone while its job is still QUEUED, however stale', async () => {
    const f = await pendingFact({});
    later(PENDING_TOPICS_STALE_MS + 1_000);

    expect(await markOrphanedFactsAsFailed(new Set([f.id]), 'dead')).toBe(0);
    expect(await getTopicsStatus(f.id)).toBe('pending');
  });

  it('errors a stale pending fact that owns NO topics, writing the column AND the legacy marker', async () => {
    const f = await pendingFact({});
    later(PENDING_TOPICS_STALE_MS + 1_000);

    expect(await markOrphanedFactsAsFailed(new Set(), 'dead')).toBe(1);

    expect(await getTopicsStatus(f.id)).toBe('error');
    expect((await metadataOf(f.id)).topicGenError).toEqual(['dead']);
  });

  it('HEALS a stale pending fact that already owns topics to done, not error', async () => {
    const f = await pendingFact({ topics: ['Dutch Politics'] });
    later(PENDING_TOPICS_STALE_MS + 1_000);

    expect(await markOrphanedFactsAsFailed(new Set(), 'dead')).toBe(1);

    expect(await getTopicsStatus(f.id)).toBe('done');
    expect((await metadataOf(f.id)).topicGenError).toBeUndefined();
  });

  it('still handles the legacy row: no status, no topics, no error marker, no live job', async () => {
    const f = await addFact('s', {});
    const noMetadata = await addFact('t');

    expect(await markOrphanedFactsAsFailed(new Set(), 'dead')).toBe(2);

    expect((await metadataOf(f.id)).topicGenError).toEqual(['dead']);
    expect((await metadataOf(noMetadata.id)).topicGenError).toEqual(['dead']);
    expect(await getTopicsStatus(f.id)).toBe('error');
  });

  it('skips a fact that already has topics, one that already has an error marker, and one in the active set', async () => {
    await addFact('has topics', { topics: ['berlin'] });
    await addFact('has error', { topicGenError: ['previous error'] });
    const live = await addFact('live job');

    expect(await markOrphanedFactsAsFailed(new Set([live.id]), 'err')).toBe(0);
  });

  it('merges the message into the existing metadata, and marks several orphans in ONE batch', async () => {
    const a = await addFact('a', { someOtherKey: ['val'] });
    const b = await addFact('b', {});

    expect(await markOrphanedFactsAsFailed(new Set(), 'custom error')).toBe(2);
    expect(await metadataOf(a.id)).toEqual({ someOtherKey: ['val'], topicGenError: ['custom error'] });
    expect(await metadataOf(b.id)).toEqual({ topicGenError: ['custom error'] });
  });

  it('is ONE batch: a failure on one orphan leaves the other unmarked too', async () => {
    const a = await addFact('a', {});
    const b = await addFact('b', {});
    failBatchWhere((op) => op.table === 'facts' && op.raw.id === b.id);

    await expect(markOrphanedFactsAsFailed(new Set(), 'x')).rejects.toThrow('batch failed (injected)');

    expect(await persistedTopicsStatus(a.id)).toBeNull();
    expect(await persistedTopicsStatus(b.id)).toBeNull();
  });
});

describe('replaceFact: accept a proposal that replaces a fact', () => {
  it('destroys the old fact AND its topics and creates the new one, defaulting to pending (it needs new topics)', async () => {
    const old = await seedFact('I live in Berlin', ['Berlin news']);
    const other = await seedFact('Follows cycling', ['Cycling']);
    await seedSuggestion('s-old', old.topics[0]);
    await seedSuggestion('s-other', other.topics[0]);

    const out = await replaceFact(old.fact.id, { statement: 'I live in Rotterdam', metadata: { topics: [] } });

    expect(out).toMatchObject({ statement: 'I live in Rotterdam', topicsStatus: 'pending' });
    expect((await getFacts()).map((f) => f.statement).sort()).toEqual(['Follows cycling', 'I live in Rotterdam']);
    expect(await countRows('topics')).toBe(1); // only the other fact's topic remains
    // The suggestions the destroyed topic retrieved go with it.
    expect(await suggestionIds()).toEqual(['s-other']);
  });

  it('honours an explicit topicsStatus and carries the questionnaire fields', async () => {
    const old = await addFact('old');

    const out = await replaceFact(old.id, {
      statement: 'new',
      topicsStatus: 'done',
      questionnaire: { level: 1, levelCategory: 'Core', attribute: 'a: b' },
    });

    expect(out).toMatchObject({ topicsStatus: 'done', questionnaireLevel: 1, questionnaireLevelCategory: 'Core', questionnaireAttribute: 'a: b' });
  });

  it('is ONE batch: when the new fact cannot be created, the old fact and its topics are still there', async () => {
    const old = await seedFact('I live in Berlin', ['Berlin news']);
    failBatchWhere((op) => op.table === 'facts' && op.state === 'create');

    await expect(replaceFact(old.fact.id, { statement: 'I live in Rotterdam' })).rejects.toThrow('batch failed (injected)');

    expect(await countRows('facts')).toBe(1);
    expect(await countRows('topics')).toBe(1);
  });

  it('a missing oldId still creates the new fact rather than throwing', async () => {
    const out = await replaceFact('ghost', { statement: 'new' });
    expect(out.statement).toBe('new');
    expect((await getFacts()).map((f) => f.statement)).toEqual(['new']);
  });
});
