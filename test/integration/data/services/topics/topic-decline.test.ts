// Staged topic deletion, its undo window and the declines it leaves, on the in-memory database with
// the real timer. The window is asserted under a strict clock (time moves only when the test moves
// it), so "the flush fires by 5 s" and "the clamp holds at 60 s" are upper bounds on fake time.
//
// Replaces topic-decline-service.test.ts (all 22 `it`): stages without destroying; decline written
// at stage time; display vs normalised text; undo clears the marker and destroys a decline THIS
// stage created; undo restores an older decline; unknown token; already committed; flush destroys +
// purges once; tracked-story guard retires; the decline stands after a retire; no decline at
// commit; two concurrent flushes; nothing staged; the metadata prune with sibling keys; an undo
// touches neither list; window clamp; window constants; removeDecline (2); re-decline refreshes
// created_at; listDeclinedTopics newest first; getAllTopicIds keeps staged rows; the FULL declined
// list.
//
// Not carried over: "the staged row `destroyPermanently` was not called" and "`mockPurge` was called
// exactly once" assert a mock; both are asserted by rows and suggestions that remain or vanish.
// "the clamp holds because nothing fires at the raw value" is now measured on a clock.
import { firstValueFrom } from 'rxjs';

import { addFact, deleteFact } from '@/lib/database/services/fact-service';
import {
  UNDO_WINDOW_MAX_MS,
  UNDO_WINDOW_MIN_MS,
  UNDO_WINDOW_MS,
  __resetPendingForTests,
  deleteTopicWithDecline,
  flushPendingDeletes,
  getAllDeclinedNormalizedTexts,
  getDeclinedTopicTexts,
  listDeclinedTopics,
  recordDecline,
  removeDecline,
  undoPendingDelete,
} from '@/lib/database/services/topic-decline-service';
import {
  createTopics,
  getActive,
  getAllTopicIds,
  getByFact,
  observeByFact,
} from '@/lib/database/services/topic-service';
import { trackStory } from '@/lib/database/services/tracked-story-service';
import { useFakeClock, useStrictClock } from '@/test/helpers';

import {
  allTopics,
  cleanupTopics,
  drive,
  metadataOf,
  resetTopicsMemory,
  seedFact,
  seedSuggestion,
  seedTopics,
  suggestionIds,
} from './support';

beforeEach(resetTopicsMemory);
afterEach(cleanupTopics);

const declines = () => firstValueFrom(listDeclinedTopics());

describe('deleteTopicWithDecline: stages, does not destroy', () => {
  it('stamps pending_delete_at, leaves the row on disk, and writes the decline at STAGE time', async () => {
    const { fact, topics } = await seedFact('Follows Dutch life', ['Dutch Politics']);
    const t = topics[0];
    const before = Date.now();

    const { undoToken } = await deleteTopicWithDecline(t.id);

    expect(undoToken).toBe(t.id);
    expect(t.pendingDeleteAt).toBeGreaterThanOrEqual(before);
    // The row EXISTS (the flush destroys it), yet no render read returns it.
    expect((await getByFact(fact.id)).map((r) => r.id)).toEqual([t.id]);
    expect(await getActive()).toEqual([]);
    expect(await firstValueFrom(observeByFact(fact.id))).toEqual([]);
    // The decline is on disk already: generation filters it out of "More topics" inside the window.
    const [decline] = await declines();
    expect(decline).toMatchObject({ text: 'Dutch Politics', normalizedText: 'dutch politics', sourceFactId: fact.id });
    expect(await getDeclinedTopicTexts()).toContain('dutch politics');
    expect(await getAllDeclinedNormalizedTexts()).toEqual(new Set(['dutch politics']));
  });
});

describe('undoPendingDelete', () => {
  it('inside the window: clears the marker (the row is live again) and destroys the decline THIS stage created', async () => {
    const { topics } = await seedFact('Follows Dutch life', ['Dutch Politics']);
    await deleteTopicWithDecline(topics[0].id);

    expect(await undoPendingDelete(topics[0].id)).toBe(true);

    expect(topics[0].pendingDeleteAt).toBeNull();
    expect((await getActive()).map((r) => r.id)).toEqual([topics[0].id]);
    expect(await declines()).toEqual([]);
  });

  it('RESTORES an older decline instead of destroying it', async () => {
    const { topics } = await seedFact('Follows Dutch life', ['Dutch Politics']);
    useFakeClock('2026-01-01T00:00:00Z');
    await recordDecline('Dutch Politics', null);
    const [old] = await declines();
    const oldMs = old.createdAt.getTime();

    jest.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    await deleteTopicWithDecline(topics[0].id);
    expect((await declines())[0].createdAt.getTime()).toBeGreaterThan(oldMs); // refreshed by the stage

    expect(await undoPendingDelete(topics[0].id)).toBe(true);

    const after = await declines();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(old.id);
    expect(after[0].createdAt.getTime()).toBe(oldMs); // put back exactly
  });

  it('returns false for an unknown token, for a second undo, and never throws', async () => {
    const { topics } = await seedFact('Follows Dutch life', ['Dutch Politics']);
    await expect(undoPendingDelete('ghost')).resolves.toBe(false);

    await deleteTopicWithDecline(topics[0].id);
    expect(await undoPendingDelete(topics[0].id)).toBe(true);
    expect(await undoPendingDelete(topics[0].id)).toBe(false);
  });

  it('returns false once the delete has committed, and the row does not come back', async () => {
    const { fact, topics } = await seedFact('Follows Dutch life', ['Dutch Politics']);
    await deleteTopicWithDecline(topics[0].id);
    await flushPendingDeletes();

    expect(await undoPendingDelete(topics[0].id)).toBe(false);
    expect(await getByFact(fact.id)).toEqual([]);
    expect(await getAllDeclinedNormalizedTexts()).toEqual(new Set(['dutch politics']));
  });
});

describe('the undo window, on a clock that only moves when driven', () => {
  /** Staged and still on disk. */
  const onDisk = async (t: { id: string }) => (await drive(allTopics())).some((r) => r.id === t.id);
  const staged = async (t: { id: string; pendingDeleteAt: number | null }) => t.pendingDeleteAt !== null && (await onDisk(t));
  const gone = async (t: { id: string }) => !(await onDisk(t));
  /** Lets the flush the TIMER started finish its DB work. Never calls flushPendingDeletes itself: that would hide a timer that did not fire. */
  const settleTimerFlush = async () => {
    for (let i = 0; i < 30; i++) {
      await jest.advanceTimersByTimeAsync(10);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  it('exposes a 5 s default with 1 s and 60 s bounds', () => {
    expect([UNDO_WINDOW_MS, UNDO_WINDOW_MIN_MS, UNDO_WINDOW_MAX_MS]).toEqual([5_000, 1_000, 60_000]);
  });

  it('inside the window an undo restores the row, and nothing destroys it later', async () => {
    const { topics } = await seedFact('Follows Dutch life', ['Dutch Politics']);
    useStrictClock(Date.now());
    await drive(deleteTopicWithDecline(topics[0].id));

    await jest.advanceTimersByTimeAsync(3_000);
    expect(await staged(topics[0])).toBe(true);
    expect(await drive(undoPendingDelete(topics[0].id))).toBe(true);

    await jest.advanceTimersByTimeAsync(120_000);
    expect(await gone(topics[0])).toBe(false);
    expect(topics[0].pendingDeleteAt).toBeNull();
  });

  it('by 5 s the timer has committed the delete, and an undo can no longer bring it back', async () => {
    const { topics } = await seedFact('Follows Dutch life', ['Dutch Politics']);
    useStrictClock(Date.now());
    await drive(deleteTopicWithDecline(topics[0].id));

    await jest.advanceTimersByTimeAsync(4_000);
    expect(await staged(topics[0])).toBe(true);

    await jest.advanceTimersByTimeAsync(1_100);
    await settleTimerFlush();
    expect(await gone(topics[0])).toBe(true);
    expect(await drive(undoPendingDelete(topics[0].id))).toBe(false);
  });

  it('a window above the ceiling is clamped to 60 s, not honoured', async () => {
    const { topics } = await seedFact('Follows Dutch life', ['Dutch Politics']);
    useStrictClock(Date.now());
    await drive(deleteTopicWithDecline(topics[0].id, { undoWindowMs: 9_999_999 }));

    await jest.advanceTimersByTimeAsync(59_000);
    expect(await staged(topics[0])).toBe(true);

    await jest.advanceTimersByTimeAsync(2_000);
    await settleTimerFlush();
    expect(await gone(topics[0])).toBe(true);
  });

  it('a window below the floor is clamped to 1 s: not instant, not an error', async () => {
    const { topics } = await seedFact('Follows Dutch life', ['Dutch Politics']);
    useStrictClock(Date.now());
    await drive(deleteTopicWithDecline(topics[0].id, { undoWindowMs: 1 }));

    await jest.advanceTimersByTimeAsync(800);
    expect(await staged(topics[0])).toBe(true);

    await jest.advanceTimersByTimeAsync(400);
    await settleTimerFlush();
    expect(await gone(topics[0])).toBe(true);
  });
});

describe('flushPendingDeletes: the commit', () => {
  it('destroys the staged row AND prunes its text from fact.metadata.topics, keeping sibling keys', async () => {
    const fact = await addFact('Follows Dutch life', {
      topics: ['Dutch  Politics', 'Cycling'],
      topicGenError: ['boom'],
      topicsReviewedAt: ['2026-01-01T00:00:00Z'],
    });
    const [t] = await seedTopics(fact.id, ['Dutch Politics']);
    await deleteTopicWithDecline(t.id);

    expect(await flushPendingDeletes()).toBe(1);

    // reader 1: the table
    expect(await getByFact(fact.id)).toEqual([]);
    // reader 2: the metadata list the facts screen renders, pruned on the NORMALISED key
    expect(await metadataOf(fact.id)).toEqual({
      topics: ['Cycling'],
      topicGenError: ['boom'],
      topicsReviewedAt: ['2026-01-01T00:00:00Z'],
    });
  });

  it('an UNDO touches neither list', async () => {
    const fact = await addFact('Follows Dutch life', { topics: ['Dutch Politics'] });
    const [t] = await seedTopics(fact.id, ['Dutch Politics']);

    await deleteTopicWithDecline(t.id);
    await undoPendingDelete(t.id);

    expect((await getByFact(fact.id)).map((r) => r.id)).toEqual([t.id]);
    expect((await metadataOf(fact.id)).topics).toEqual(['Dutch Politics']);
  });

  it('RETIRES instead of destroying when a live tracked story points at the topic; the decline still stands', async () => {
    const { fact, topics } = await seedFact('Follows Gaza news', ['Gaza ceasefire']);
    const t = topics[0];
    await trackStory({ articleId: 'a1', title: 'Gaza talks', originSurface: 'feed', topicId: t.id, topicText: 'Gaza ceasefire' });
    await seedSuggestion('s-gaza', t);
    await deleteTopicWithDecline(t.id);

    expect(await flushPendingDeletes()).toBe(1);

    const rows = await getByFact(fact.id);
    expect(rows.map((r) => [r.id, r.status, r.pendingDeleteAt])).toEqual([[t.id, 'retired', null]]);
    expect(await getAllDeclinedNormalizedTexts()).toEqual(new Set(['gaza ceasefire']));
    // Nothing was destroyed, so no suggestion was purged.
    expect(await suggestionIds()).toEqual(['s-gaza']);
  });

  it('in one flush, retires the tracked-story topic and destroys the other', async () => {
    const { fact, topics } = await seedFact('Follows Gaza news', ['Gaza ceasefire', 'Rafah crossing']);
    await trackStory({ articleId: 'a1', title: 'Gaza talks', originSurface: 'feed', topicId: topics[0].id, topicText: 'Gaza ceasefire' });
    await deleteTopicWithDecline(topics[0].id);
    await deleteTopicWithDecline(topics[1].id);

    expect(await flushPendingDeletes()).toBe(2);

    expect((await getByFact(fact.id)).map((r) => [r.id, r.status])).toEqual([[topics[0].id, 'retired']]);
  });

  it('writes NO decline at commit: the one written at stage time is untouched', async () => {
    const { topics } = await seedFact('Follows Dutch life', ['Dutch Politics']);
    await deleteTopicWithDecline(topics[0].id);
    const [staged] = await declines();

    await flushPendingDeletes();

    const after = await declines();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(staged.id);
    expect(after[0].createdAt.getTime()).toBe(staged.createdAt.getTime());
  });

  it('two concurrent flushes commit once', async () => {
    const { fact, topics } = await seedFact('Follows Dutch life', ['Dutch Politics']);
    await deleteTopicWithDecline(topics[0].id);

    const [a, b] = await Promise.all([flushPendingDeletes(), flushPendingDeletes()]);

    expect([a, b]).toEqual([1, 1]);
    expect(await getByFact(fact.id)).toEqual([]);
  });

  it('commits a delete staged before the process died: the column is the guarantee, not the timer', async () => {
    const { fact, topics } = await seedFact('Follows Dutch life', ['Dutch Politics']);
    await deleteTopicWithDecline(topics[0].id);
    __resetPendingForTests(); // a new process: the in-memory undo bookkeeping and its timer are gone

    expect(await flushPendingDeletes()).toBe(1);

    expect(await getByFact(fact.id)).toEqual([]);
    expect(await undoPendingDelete(topics[0].id)).toBe(false);
  });

  it('is a no-op with nothing staged: returns 0, leaves live rows alone and purges nothing', async () => {
    const { topics } = await seedFact('Follows Dutch life', ['Dutch Politics']);
    // A suggestion whose topic id exists nowhere would be purged by any purge run.
    await seedSuggestion('s-orphan', { id: 'no-such-topic', text: 'x' });

    expect(await flushPendingDeletes()).toBe(0);

    expect((await getActive()).map((r) => r.id)).toEqual([topics[0].id]);
    expect(await suggestionIds()).toEqual(['s-orphan']);
  });
});

describe('getAllTopicIds keeps staged rows: the purge guard', () => {
  it('a purge run inside the undo window destroys a deleted fact\'s suggestions but not the staged topic\'s, until the commit', async () => {
    const staged = await seedFact('Follows Dutch life', ['Dutch Politics']);
    const doomed = await seedFact('Follows chess', ['Chess openings']);
    await seedSuggestion('s-staged', staged.topics[0]);
    await seedSuggestion('s-doomed', doomed.topics[0]);
    await deleteTopicWithDecline(staged.topics[0].id);
    expect((await getAllTopicIds()).has(staged.topics[0].id)).toBe(true);

    // deleteFact cascades the topic and purges against getAllTopicIds().
    await deleteFact(doomed.fact.id);

    expect(await suggestionIds()).toEqual(['s-staged']);
    expect(await undoPendingDelete(staged.topics[0].id)).toBe(true);
    expect(await suggestionIds()).toEqual(['s-staged']);

    // Once the delete commits, the suggestion has no owner any more and goes.
    await deleteTopicWithDecline(staged.topics[0].id);
    await flushPendingDeletes();
    expect(await suggestionIds()).toEqual([]);
  });
});

describe('declines as a visible preference', () => {
  it('recordDecline stores the display text trimmed and the normalised key, and says it was new', async () => {
    const fact = await addFact('Follows Dutch life');

    const out = await recordDecline('  Dutch  Politics ', fact.id);

    expect(out.previousCreatedAtMs).toBeNull();
    expect(await declines()).toEqual([
      expect.objectContaining({ id: out.id, text: 'Dutch  Politics', normalizedText: 'dutch politics', sourceFactId: fact.id }),
    ]);
  });

  it('refuses empty text', async () => {
    await expect(recordDecline('   ', null)).rejects.toThrow('recordDecline: empty text');
  });

  it('a re-decline refreshes created_at instead of adding a second row, and reports the previous stamp', async () => {
    useFakeClock('2026-01-01T00:00:00Z');
    const first = await recordDecline('Dutch Politics', 'f1');
    jest.setSystemTime(new Date('2026-02-01T00:00:00Z'));

    const again = await recordDecline('dutch  politics', null);

    expect(again.id).toBe(first.id);
    expect(again.previousCreatedAtMs).toBe(Date.parse('2026-01-01T00:00:00Z'));
    const rows = await declines();
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt.getTime()).toBe(Date.parse('2026-02-01T00:00:00Z'));
    // No fact on the re-decline: the earlier source fact is kept.
    expect(rows[0].sourceFactId).toBe('f1');
  });

  it('getDeclinedTopicTexts is a 50-row page, newest first, in normalised form; getAllDeclinedNormalizedTexts returns ALL', async () => {
    useFakeClock('2026-01-01T00:00:00Z');
    for (let i = 0; i < 60; i++) {
      jest.setSystemTime(Date.parse('2026-01-01T00:00:00Z') + i * 1_000);
      await recordDecline(`Topic ${i}`, null);
    }

    const page = await getDeclinedTopicTexts();
    const all = await getAllDeclinedNormalizedTexts();

    expect(page).toHaveLength(50);
    expect(all.size).toBe(60);
    expect(page.slice(0, 3)).toEqual(['topic 59', 'topic 58', 'topic 57']);
    expect(page.every((t) => all.has(t))).toBe(true);
    expect(all.has('topic 0')).toBe(true);
    expect(page).not.toContain('topic 0'); // the 51st-oldest decline is outside the prompt page
    expect(await getDeclinedTopicTexts(5)).toEqual(['topic 59', 'topic 58', 'topic 57', 'topic 56', 'topic 55']);
  });

  it('listDeclinedTopics emits newest first', async () => {
    useFakeClock('2026-01-01T00:00:00Z');
    await recordDecline('Old one', null);
    jest.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    await recordDecline('New one', null);

    expect((await declines()).map((d) => d.text)).toEqual(['New one', 'Old one']);
  });

  it('removeDecline destroys the row and does NOT touch topics', async () => {
    const { topics } = await seedFact('Follows Dutch life', ['Dutch Politics']);
    const { id } = await recordDecline('Something else', null);

    await removeDecline(id);

    expect(await declines()).toEqual([]);
    expect((await getActive()).map((r) => r.id)).toEqual([topics[0].id]);
  });

  it('removeDecline on a missing row is a no-op, not a throw', async () => {
    await expect(removeDecline('ghost')).resolves.toBeUndefined();
  });

  it('forgetting a decline lets the interest be minted again', async () => {
    const { fact, topics } = await seedFact('Follows Dutch life', ['Dutch Politics']);
    await deleteTopicWithDecline(topics[0].id);
    await flushPendingDeletes();
    const [decline] = await declines();

    await removeDecline(decline.id);

    expect(await getAllDeclinedNormalizedTexts()).toEqual(new Set());
    const [minted] = await createTopics([{ factId: fact.id, text: 'Dutch Politics', weight: 0.75 }]);
    expect(minted.id).not.toBe(topics[0].id);
  });
});
