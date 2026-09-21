/**
 * Staged topic deletion, the 5s undo, and the declines it leaves behind.
 *
 * The shared database mock IGNORES `Q.where`, so anywhere the predicate IS the
 * behaviour these tests assert on `collection.query.mock.calls` rather than on
 * the rows that come back. A result-shaped assertion there passes just as
 * happily with a wrong clause.
 */
jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), captureException: jest.fn(), error: jest.fn() },
}));
// Rest params declared so `...a` forwards and stays assertable — a mock that
// silently drops a trailing argument makes a changed contract untestable.
const mockPurge = jest.fn(async (..._a: unknown[]) => 0);
jest.mock('../article-suggestion-service', () => ({
  purgeSuggestionsForDeadTopics: (...a: unknown[]) => mockPurge(...a),
}));

import database from '@/lib/database/index';
import { makeRecord, type MockDatabase } from '@/lib/__test-helpers__/mockDatabase';
import * as svc from '../topic-decline-service';
import { getAllTopicIds } from '../topic-service';

const db = database as unknown as MockDatabase;

function topicRow(over: Record<string, unknown> = {}) {
  return makeRecord({
    id: 't1',
    factId: 'f1',
    text: 'Dutch Politics',
    normalizedText: 'dutch politics',
    status: 'active',
    pendingDeleteAt: null,
    ...over,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  svc.__resetPendingForTests();
  db._setRows('topics', [topicRow()]);
  db._setRows('declined_topics', []);
  db._setRows('facts', []);
  db._setRows('tracked_stories', []);
});

describe('deleteTopicWithDecline — stages, does not destroy', () => {
  it('marks pending_delete_at and does NOT destroy the row', async () => {
    const topic = topicRow();
    db._setRows('topics', [topic]);

    const { undoToken } = await svc.deleteTopicWithDecline('t1');

    expect(undoToken).toBe('t1');
    expect(typeof topic.pendingDeleteAt).toBe('number');
    expect(topic.destroyPermanently).not.toHaveBeenCalled();
    expect(topic.prepareDestroyPermanently).not.toHaveBeenCalled();
  });

  it('records the decline AT STAGE TIME — the re-mint race regression', async () => {
    // Deleting a chip then tapping "More topics" inside the undo window used
    // to regenerate the same topic: the staged row is invisible to
    // createTopics' dedup, so a fresh row was minted. The decline must already
    // be on disk at that moment for generation to filter the text out.
    await svc.deleteTopicWithDecline('t1');

    const texts = await svc.getDeclinedTopicTexts();
    expect(texts).toContain('dutch politics');
  });

  it('stores the DISPLAY text and the normalised key separately', async () => {
    await svc.deleteTopicWithDecline('t1');
    // The mock's `create` is async AND pushes into _rows, so read the row
    // there — `mock.results[0].value` is a Promise, not the record.
    const created = db._collections['declined_topics']._rows[0];
    expect(created.text).toBe('Dutch Politics');
    expect(created.normalizedText).toBe('dutch politics');
  });
});

describe('undoPendingDelete', () => {
  it('clears the marker and destroys a decline THIS stage created', async () => {
    const topic = topicRow();
    db._setRows('topics', [topic]);
    await svc.deleteTopicWithDecline('t1');
    const declineRow = db._collections['declined_topics']._rows[0];

    const ok = await svc.undoPendingDelete('t1');

    expect(ok).toBe(true);
    expect(topic.pendingDeleteAt).toBeNull();
    expect(declineRow.prepareDestroyPermanently).toHaveBeenCalled();
  });

  it('RESTORES an older decline instead of destroying it', async () => {
    // A decline the user made weeks ago must survive an undo of today's
    // delete. Destroying it would silently forget a separate decision.
    const old = new Date('2026-01-01T00:00:00Z');
    const existing = makeRecord({
      id: 'd-old',
      text: 'Dutch Politics',
      normalizedText: 'dutch politics',
      sourceFactId: null,
      createdAt: old,
    });
    db._setRows('declined_topics', [existing]);
    const topic = topicRow();
    db._setRows('topics', [topic]);

    await svc.deleteTopicWithDecline('t1');
    expect(existing.createdAt.getTime()).not.toBe(old.getTime()); // refreshed

    await svc.undoPendingDelete('t1');

    expect(existing.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(existing.createdAt.getTime()).toBe(old.getTime()); // put back
  });

  it('returns false for an unknown token and never throws', async () => {
    db._collections['topics'].find.mockRejectedValueOnce(new Error('nope'));
    await expect(svc.undoPendingDelete('ghost')).resolves.toBe(false);
  });

  it('returns false once the delete has committed', async () => {
    const topic = topicRow({ pendingDeleteAt: null });
    db._setRows('topics', [topic]);
    await expect(svc.undoPendingDelete('t1')).resolves.toBe(false);
  });
});

describe('flushPendingDeletes — commit', () => {
  it('destroys the staged row and purges its suggestions exactly once', async () => {
    const topic = topicRow({ pendingDeleteAt: Date.now() });
    db._setRows('topics', [topic]);

    const n = await svc.flushPendingDeletes();

    expect(n).toBe(1);
    expect(topic.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    expect(mockPurge).toHaveBeenCalledTimes(1);
  });

  it('RETIRES instead of destroying when a tracked story points at the topic', async () => {
    // tracked_stories.topic_id is a real reference: destroying the topic
    // leaves it dangling and that followed story silently stops matching new
    // articles forever.
    const topic = topicRow({ pendingDeleteAt: Date.now() });
    db._setRows('topics', [topic]);
    db._setRows('tracked_stories', [makeRecord({ id: 's1', topicId: 't1' })]);

    await svc.flushPendingDeletes();

    expect(topic.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(topic.status).toBe('retired');
    expect(topic.pendingDeleteAt).toBeNull();
  });

  it('the decline still stands when the guard retired the row', async () => {
    db._setRows('topics', [topicRow()]);
    db._setRows('tracked_stories', [makeRecord({ id: 's1', topicId: 't1' })]);
    await svc.deleteTopicWithDecline('t1');

    await svc.flushPendingDeletes();

    expect(await svc.getDeclinedTopicTexts()).toContain('dutch politics');
  });

  it('writes NO decline at commit — that happened at stage time', async () => {
    db._setRows('topics', [topicRow({ pendingDeleteAt: Date.now() })]);
    await svc.flushPendingDeletes();
    expect(db._collections['declined_topics'].create).not.toHaveBeenCalled();
  });

  it('two concurrent flushes commit once', async () => {
    db._setRows('topics', [topicRow({ pendingDeleteAt: Date.now() })]);
    const [a, b] = await Promise.all([
      svc.flushPendingDeletes(),
      svc.flushPendingDeletes(),
    ]);
    expect(mockPurge).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('is a no-op with nothing staged, and does not purge', async () => {
    db._setRows('topics', []);
    expect(await svc.flushPendingDeletes()).toBe(0);
    expect(mockPurge).not.toHaveBeenCalled();
  });
});

describe('B3 — both readers agree after a commit', () => {
  it('prunes the committed text from fact.metadata.topics', async () => {
    // The facts screen renders `fact.metadata.topics` while the chat card
    // renders the topics table. A test asserting ONE source passes while the
    // bug is live, so both are asserted here together.
    const fact = makeRecord({
      id: 'f1',
      metadata: {
        topics: ['Dutch Politics', 'Cycling'],
        topicGenError: ['boom'],
        topicsReviewedAt: ['2026-01-01T00:00:00Z'],
      },
    });
    db._setRows('facts', [fact]);
    const topic = topicRow({ pendingDeleteAt: Date.now() });
    db._setRows('topics', [topic]);

    await svc.flushPendingDeletes();

    // reader 1: the table
    expect(topic.prepareDestroyPermanently).toHaveBeenCalled();
    // reader 2: the metadata list
    expect(fact.metadata.topics).toEqual(['Cycling']);
    // the wholesale-assign trap: siblings must survive the prune
    expect(fact.metadata.topicGenError).toEqual(['boom']);
    expect(fact.metadata.topicsReviewedAt).toEqual(['2026-01-01T00:00:00Z']);
  });

  it('an UNDO touches neither reader', async () => {
    const fact = makeRecord({ id: 'f1', metadata: { topics: ['Dutch Politics'] } });
    db._setRows('facts', [fact]);
    const topic = topicRow();
    db._setRows('topics', [topic]);

    await svc.deleteTopicWithDecline('t1');
    await svc.undoPendingDelete('t1');

    expect(topic.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(fact.metadata.topics).toEqual(['Dutch Politics']);
  });
});

describe('undo window', () => {
  it('clamps an out-of-range window instead of throwing', async () => {
    jest.useFakeTimers();
    try {
      db._setRows('topics', [topicRow()]);
      await expect(
        svc.deleteTopicWithDecline('t1', { undoWindowMs: 9_999_999 }),
      ).resolves.toEqual({ undoToken: 't1' });
      // Clamped to the 60s ceiling: nothing fires at the raw value, and the
      // row is still staged rather than committed.
      jest.advanceTimersByTime(svc.UNDO_WINDOW_MAX_MS - 1);
      expect(mockPurge).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('exposes a 5s default with 1s/60s bounds', () => {
    expect(svc.UNDO_WINDOW_MS).toBe(5_000);
    expect(svc.UNDO_WINDOW_MIN_MS).toBe(1_000);
    expect(svc.UNDO_WINDOW_MAX_MS).toBe(60_000);
  });
});

describe('declines as a visible preference', () => {
  it('removeDecline destroys the row and does NOT touch topics', async () => {
    const row = makeRecord({ id: 'd1', normalizedText: 'x', text: 'X' });
    db._setRows('declined_topics', [row]);
    const topic = topicRow();
    db._setRows('topics', [topic]);

    await svc.removeDecline('d1');

    expect(row.prepareDestroyPermanently).toHaveBeenCalled();
    expect(topic.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(topic.prepareUpdate).not.toHaveBeenCalled();
  });

  it('removeDecline on a missing row is a no-op, not a throw', async () => {
    db._collections['declined_topics'].find.mockRejectedValueOnce(new Error('gone'));
    await expect(svc.removeDecline('ghost')).resolves.toBeUndefined();
  });

  it('a re-decline refreshes created_at instead of adding a second row', async () => {
    const row = makeRecord({
      id: 'd1',
      text: 'Dutch Politics',
      normalizedText: 'dutch politics',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    db._setRows('declined_topics', [row]);

    await svc.recordDecline('Dutch Politics', 'f1');

    expect(db._collections['declined_topics'].create).not.toHaveBeenCalled();
    expect(row.createdAt.getTime()).toBeGreaterThan(
      new Date('2026-01-01T00:00:00Z').getTime(),
    );
  });

  it('listDeclinedTopics sorts newest first — asserted on the QUERY, not the rows', () => {
    // The shared mock's query() returns only {fetch, fetchCount}; stub an
    // observe() locally rather than widening a helper outside this area.
    const observe = jest.fn(() => 'observable');
    db._collections['declined_topics'].query.mockReturnValueOnce({ observe } as never);

    expect(svc.listDeclinedTopics()).toBe('observable');
    const args = db._collections['declined_topics'].query.mock.calls.at(-1);
    expect(JSON.stringify(args)).toContain('created_at');
    expect(JSON.stringify(args)).toContain('desc');
  });
});

describe('getAllTopicIds keeps staged rows — the purge guard', () => {
  it('does NOT filter on pending_delete_at', async () => {
    // Filtering staged rows out here would let purgeSuggestionsForDeadTopics
    // destroy, during the undo window, suggestions an undo cannot restore.
    // The mock ignores predicates, so assert the QUERY.
    db._setRows('topics', [topicRow({ pendingDeleteAt: Date.now() })]);
    const ids = await getAllTopicIds();

    expect(ids.has('t1')).toBe(true);
    const args = db._collections['topics'].query.mock.calls.at(-1);
    expect(JSON.stringify(args ?? [])).not.toContain('pending_delete_at');
  });
});
