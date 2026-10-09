// topic-service on the in-memory database: the createTopics dedupe floor and its metadata pairing,
// the staged-delete split between render reads and "does it exist" reads, observeNegative, the
// weight repair and the orphan sweep. Real services, real rows; the only fault is a key-scoped
// batch failure (R26).
//
// Replaces (all `it`):
//   topic-service-create-dedupe.test.ts (15): empty input; create when nothing matches; resolve
//     the existing row; case and whitespace; suppressed row is live; retired row exempt; same text
//     under another fact; same text same fact; fact-owned vs unowned; intra-batch repeats; input
//     order; never an undefined hole; requested fields; getAllNormalizedTexts (2)
//   topic-service-metadata-pairing.test.ts (5): direct call pairs table + metadata in one batch;
//     no factId writes no fact; sibling metadata keys; no duplicate in metadata; staged rows are
//     excluded from the dedup
//   topic-service-observe-negative.test.ts (3): negative-active or suppressed, ascending; no
//     retired / zero / positive; ascending order
//   topic-service-orphan-sweep.test.ts (4): query shape; destroys exactly the orphans; never
//     touches location topics; no-op when nothing is orphaned
//   topic-service-weight-repair.test.ts (4): no-op; lifts to the generated weight; exactly 0 never a
//     downrank; only active fact-owned rows with both defaults
//
// Not carried over: "the query is `fact_id NOT NULL`", "the clause list has 4 entries", "the clause
// contains `lt` not `lte`" and "the dedup query names pending_delete_at" assert the QUERY handed to
// a mock; the same rules are asserted here by what the real database returns for rows that sit on
// each side of each clause. "returns [] and does not write" asserted `db.write` was not called: here
// it is asserted that no row appears.
import { firstValueFrom } from 'rxjs';

import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { deleteTopicWithDecline } from '@/lib/database/services/topic-decline-service';
import {
  countActiveTopicsIncludingStaged,
  countAllTopics,
  createTopics,
  destroyOrphanedTopics,
  getActive,
  getActiveTopicSnapshots,
  getAllByNormalizedText,
  getAllNormalizedTexts,
  getAllTopicIds,
  getAllTopicSnapshots,
  getByFact,
  getTopupTopicSnapshots,
  getWeightsByIds,
  normalizeTopicText,
  observeByFact,
  observeNegative,
  reactivate,
  repairUnweightedTopics,
  retire,
  setHighPriority,
  setWeight,
  suppress,
} from '@/lib/database/services/topic-service';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';

import {
  allTopics,
  cleanupTopics,
  collect,
  countRows,
  destroyFactRowOnly,
  failBatchWhere,
  metadataOf,
  metadataTopics,
  persistedMetadataTopics,
  resetTopicsMemory,
  seedFact,
  seedTopics,
  until,
} from './support';

beforeEach(resetTopicsMemory);
afterEach(cleanupTopics);

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe('createTopics: the dedupe floor', () => {
  it('returns [] for an empty input and writes no row', async () => {
    expect(await createTopics([])).toEqual([]);
    expect(await allTopics()).toHaveLength(0);
  });

  it('creates a row when nothing matches, with the requested fields and the defaults', async () => {
    const [row] = await createTopics([{ text: 'Bhopal news', weight: 0.75 }]);

    expect(row).toMatchObject({
      text: 'Bhopal news',
      normalizedText: 'bhopal news',
      weight: 0.75,
      status: 'active',
      provenance: 'user',
      highPriority: false,
      factId: null,
      locationId: null,
      lastSignalAt: null,
      pendingDeleteAt: null,
    });
    expect(ids(await getAllByNormalizedText('Bhopal news'))).toEqual([row.id]);
  });

  it('carries every requested field onto a new row', async () => {
    const [row] = await createTopics([
      {
        text: 'Tracked story',
        weight: 0.9,
        status: 'suppressed',
        provenance: 'tracked',
        highPriority: true,
        locationId: 'loc-1',
        lastSignalAt: 1234,
      },
    ]);
    expect(row).toMatchObject({
      weight: 0.9,
      status: 'suppressed',
      provenance: 'tracked',
      highPriority: true,
      locationId: 'loc-1',
      lastSignalAt: 1234,
    });
  });

  it('RETURNS the existing row instead of creating a duplicate (resolve-or-create, never filter)', async () => {
    const [first] = await createTopics([{ text: 'Bhopal news', weight: 0.75 }]);

    const out = await createTopics([{ text: 'Bhopal News', weight: 0.75 }]);

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(first.id);
    expect(await allTopics()).toHaveLength(1);
  });

  it('matches on the normalised key: case, outer and inner whitespace', async () => {
    const [first] = await createTopics([{ text: 'bhopal news', weight: 0.75 }]);

    const out = await createTopics([{ text: '  BHOPAL   news  ', weight: 0.75 }]);

    expect(out[0].id).toBe(first.id);
    expect(await allTopics()).toHaveLength(1);
  });

  it('"Dutch  politics" dedupes against "dutch politics" for the same fact, and lands once in the metadata list', async () => {
    const { fact, topics } = await seedFact('Follows Dutch life', ['dutch politics']);

    const out = await createTopics([{ factId: fact.id, text: 'Dutch  politics', weight: 0.75 }]);

    expect(out[0].id).toBe(topics[0].id);
    expect(await getByFact(fact.id)).toHaveLength(1);
    // Both topic readers in one test: the table AND the legacy list.
    expect(await metadataTopics(fact.id)).toEqual(['dutch politics']);
  });

  it('treats a suppressed row as live: it blocks a duplicate create', async () => {
    const [row] = await createTopics([{ text: 'Bhopal news', weight: 0.75 }]);
    await suppress(row.id);

    const out = await createTopics([{ text: 'Bhopal news', weight: 0.75 }]);

    expect(out[0].id).toBe(row.id);
    expect(await allTopics()).toHaveLength(1);
  });

  it('does NOT let a retired row block a create (retired is exempt)', async () => {
    const [row] = await createTopics([{ text: 'Bhopal news', weight: 0.75 }]);
    await retire(row.id);

    const out = await createTopics([{ text: 'Bhopal news', weight: 0.75 }]);

    expect(out).toHaveLength(1);
    expect(out[0].id).not.toBe(row.id);
    expect(out[0].status).toBe('active');
    expect(await allTopics()).toHaveLength(2);
  });

  it('does NOT resolve to a row staged for deletion (the deliberate exception): a fresh row is minted', async () => {
    const { fact, topics } = await seedFact('Follows Dutch life', ['Dutch politics']);
    await deleteTopicWithDecline(topics[0].id);

    const out = await createTopics([{ factId: fact.id, text: 'Dutch politics', weight: 0.75 }]);

    expect(out[0].id).not.toBe(topics[0].id);
    expect(out[0].pendingDeleteAt).toBeNull();
    // The staged row is still there, still staged.
    const rows = await getByFact(fact.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === topics[0].id)?.pendingDeleteAt).not.toBeNull();
  });

  describe('the key is (normalized_text, fact_id)', () => {
    it('still creates the same text under a DIFFERENT fact', async () => {
      const a = await seedFact('Follows tech policy', ['AI regulation']);
      const b = await addFact('Works in AI');

      const out = await createTopics([{ factId: b.id, text: 'AI regulation', weight: 0.75 }]);

      expect(out[0].factId).toBe(b.id);
      expect(out[0].id).not.toBe(a.topics[0].id);
      expect(ids(await getAllByNormalizedText('ai regulation'))).toHaveLength(2);
    });

    it('dedupes the same text under the SAME fact', async () => {
      const a = await seedFact('Follows tech policy', ['AI regulation']);

      const out = await createTopics([{ factId: a.fact.id, text: 'AI regulation', weight: 0.75 }]);

      expect(out[0].id).toBe(a.topics[0].id);
      expect(await allTopics()).toHaveLength(1);
    });

    it('does not match a fact-owned row against an unowned (fact_id null) input', async () => {
      await seedFact('Follows tech policy', ['AI regulation']);

      const out = await createTopics([{ text: 'AI regulation', weight: 0.75 }]);

      expect(out[0].factId).toBeNull();
      expect(await allTopics()).toHaveLength(2);
    });
  });

  describe('within one batch', () => {
    it('collapses repeats to a single create, one returned row per input', async () => {
      const out = await createTopics([
        { text: 'Bhopal news', weight: 0.75 },
        { text: 'bhopal NEWS', weight: 0.75 },
        { text: 'Amsterdam news', weight: 0.75 },
      ]);

      expect(out).toHaveLength(3);
      expect(out[0].id).toBe(out[1].id);
      expect(out[2].normalizedText).toBe('amsterdam news');
      expect(await allTopics()).toHaveLength(2);
    });

    it('preserves input order when some inputs resolve and some are created, never leaving a hole', async () => {
      const [mid] = await createTopics([{ text: 'second', weight: 0.75 }]);

      const out = await createTopics([
        { text: 'first', weight: 0.75 },
        { text: 'Second', weight: 0.75 },
        { text: 'third', weight: 0.75 },
      ]);

      expect(out).toHaveLength(3);
      for (const row of out) expect(row).toBeDefined();
      expect(out.map((r) => r.normalizedText)).toEqual(['first', 'second', 'third']);
      expect(out[1].id).toBe(mid.id);
    });
  });
});

describe('createTopics: the metadata pairing (fact.metadata.topics is a second topic list)', () => {
  it('a DIRECT call updates the table AND fact.metadata.topics, keeping sibling metadata keys', async () => {
    const fact = await addFact('Follows Dutch life', {
      topics: ['Cycling'],
      topicGenError: ['boom'],
      topicsReviewedAt: ['2026-01-01T00:00:00Z'],
    });

    await createTopics([{ factId: fact.id, text: 'Dutch Politics', weight: 0.75 }]);

    expect((await getByFact(fact.id)).map((t) => t.text)).toEqual(['Dutch Politics']);
    // The wholesale-assign trap: writing `{ topics }` alone would drop these.
    expect(await metadataOf(fact.id)).toEqual({
      topics: ['Cycling', 'Dutch Politics'],
      topicGenError: ['boom'],
      topicsReviewedAt: ['2026-01-01T00:00:00Z'],
    });
  });

  it('seeds the list for a fact that has no metadata at all', async () => {
    const fact = await addFact('Follows Dutch life');

    await createTopics([{ factId: fact.id, text: 'Dutch Politics', weight: 0.75 }]);

    expect(await metadataTopics(fact.id)).toEqual(['Dutch Politics']);
  });

  it('appends every new text of a batch once, in order, normalising the dedup key', async () => {
    const fact = await addFact('Follows Dutch life', { topics: ['Dutch Politics'] });

    await createTopics([
      { factId: fact.id, text: 'dutch  politics', weight: 0.75 },
      { factId: fact.id, text: 'Dutch cycling', weight: 0.75 },
      { factId: fact.id, text: 'DUTCH   CYCLING', weight: 0.75 },
    ]);

    // "dutch  politics" already is a metadata entry ("Dutch Politics", same key), so it adds none,
    // yet the table has no row for it yet, so it is minted: the two lists differ in what they had.
    expect((await getByFact(fact.id)).map((t) => t.normalizedText).sort()).toEqual(['dutch cycling', 'dutch politics']);
    expect(await metadataTopics(fact.id)).toEqual(['Dutch Politics', 'Dutch cycling']);
  });

  it('an input with NO factId writes no fact row at all', async () => {
    const fact = await addFact('Follows cycling', { topics: ['Cycling'] });
    const before = (await getFacts()).find((f) => f.id === fact.id)!;

    await createTopics([{ text: 'Some Disliked Thing', provenance: 'feedback', weight: -0.5 }]);

    const after = (await getFacts()).find((f) => f.id === fact.id)!;
    expect(after.metadata).toEqual({ topics: ['Cycling'] });
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it('commits the topic rows and the metadata in ONE batch: a failing fact write leaves neither', async () => {
    const fact = await addFact('Follows cycling', { topics: ['Cycling'] });
    failBatchWhere((op) => op.table === 'facts');

    await expect(createTopics([{ factId: fact.id, text: 'Dutch Politics', weight: 0.75 }])).rejects.toThrow(
      'batch failed (injected)',
    );

    expect(await countRows('topics')).toBe(0);
    expect(await persistedMetadataTopics(fact.id)).toEqual(['Cycling']);
  });
});

describe('reads: render reads exclude a staged row, "does it exist" reads include it', () => {
  /** active A (fact F), negative-weight active B, suppressed S, retired R, staged T, a fact-less tracked K. */
  async function world() {
    const { fact, topics } = await seedFact('Follows Dutch life', [
      { text: 'A active', weight: 0.8 },
      { text: 'B active negative', weight: -0.4 },
      { text: 'S suppressed', status: 'suppressed' },
      { text: 'R retired', status: 'retired' },
      { text: 'T staged', weight: 0.6 },
    ]);
    const [a, b, s, r, t] = topics;
    const [k] = await createTopics([{ text: 'K tracked', weight: 0.85, provenance: 'tracked', highPriority: true }]);
    await deleteTopicWithDecline(t.id);
    return { fact, a, b, s, r, t, k };
  }

  it('getActive: active rows only, no suppressed, retired or staged (any weight)', async () => {
    const w = await world();
    expect(ids(await getActive())).toEqual(ids([w.a, w.b, w.k]));
  });

  it('getActiveTopicSnapshots: the same set, projected', async () => {
    const w = await world();
    const snaps = await getActiveTopicSnapshots();
    expect(snaps.map((s) => s.id).sort()).toEqual(ids([w.a, w.b, w.k]));
    expect(snaps.find((s) => s.id === w.k.id)).toEqual({ id: w.k.id, factId: null, weight: 0.85, highPriority: true });
    expect(snaps.find((s) => s.id === w.a.id)).toMatchObject({ factId: w.fact.id, weight: 0.8, highPriority: false });
  });

  it('countActiveTopicsIncludingStaged counts the staged ACTIVE row, and still not suppressed or retired', async () => {
    await world();
    // A, B, K active + T active-but-staged
    expect(await countActiveTopicsIncludingStaged()).toBe(4);
  });

  it('getAllTopicIds INCLUDES staged rows (and retired and suppressed): the purge-safety set', async () => {
    const w = await world();
    const all = await getAllTopicIds();
    expect(all).toEqual(new Set([w.a.id, w.b.id, w.s.id, w.r.id, w.t.id, w.k.id]));
  });

  it('getAllNormalizedTexts is every text on the device, staged and retired included', async () => {
    await world();
    expect(await getAllNormalizedTexts()).toEqual(
      new Set(['a active', 'b active negative', 's suppressed', 'r retired', 't staged', 'k tracked']),
    );
  });

  it('getAllNormalizedTexts is empty for an empty table', async () => {
    expect(await getAllNormalizedTexts()).toEqual(new Set());
  });

  it('countAllTopics and getAllTopicSnapshots are every status but not the staged row', async () => {
    const w = await world();
    expect(await countAllTopics()).toBe(5);
    const snaps = await getAllTopicSnapshots();
    expect(snaps.map((s) => s.id).sort()).toEqual(ids([w.a, w.b, w.s, w.r, w.k]));
    expect(snaps.find((s) => s.id === w.s.id)).toMatchObject({ status: 'suppressed', text: 'S suppressed' });
    expect(snaps.find((s) => s.id === w.a.id)?.lastSignalAtMs).toBeNull();
  });

  it('getTopupTopicSnapshots: fact-owned rows of any status, not staged, not fact-less', async () => {
    const w = await world();
    const snaps = await getTopupTopicSnapshots();
    expect(snaps.map((s) => s.id).sort()).toEqual(ids([w.a, w.b, w.s, w.r]));
    expect(snaps.find((s) => s.id === w.a.id)).toMatchObject({ factId: w.fact.id, isActive: true });
    expect(snaps.find((s) => s.id === w.r.id)?.isActive).toBe(false);
    expect(snaps.find((s) => s.id === w.a.id)!.createdAtMs).toBeGreaterThan(0);
  });

  it('getWeightsByIds returns the rows that exist, staged included, and drops unknown ids', async () => {
    const w = await world();
    expect(await getWeightsByIds([])).toEqual([]);
    const out = await getWeightsByIds([w.a.id, w.t.id, 'ghost']);
    expect(out.sort((x, y) => x.id.localeCompare(y.id))).toEqual(
      [
        { id: w.a.id, weight: 0.8 },
        { id: w.t.id, weight: 0.6 },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
  });

  it('observeByFact: every status of the fact except the staged row, re-emitting when a status flips in place', async () => {
    const w = await world();
    const feed = collect(observeByFact(w.fact.id));
    await until(() => feed.seen.length >= 1, 'first emission');
    expect(ids(feed.seen[0])).toEqual(ids([w.a, w.b, w.s, w.r]));

    await retire(w.a.id);

    await until(() => feed.seen.length >= 2, 'emission after the status flip');
    expect(feed.seen.at(-1)!.find((r) => r.id === w.a.id)?.status).toBe('retired');
    feed.stop();
  });
});

describe('observeNegative: the Not-interested list', () => {
  it('emits negative-weight ACTIVE rows and every SUPPRESSED row, weakest first; never retired, neutral, positive or staged', async () => {
    const { topics } = await seedFact('Follows Dutch life', [
      { text: 'dislike mild', weight: -0.2 },
      { text: 'dislike strong', weight: -0.8 },
      { text: 'neutral', weight: 0 },
      { text: 'liked', weight: 0.5 },
      { text: 'hidden', status: 'suppressed', weight: 0.9 },
      { text: 'history', status: 'retired', weight: -0.5 },
      { text: 'staged dislike', weight: -0.9 },
    ]);
    const [mild, strong, , , hidden, , staged] = topics;
    await deleteTopicWithDecline(staged.id);

    const rows = await firstValueFrom(observeNegative());

    // Ascending by weight: the strongest dislike first.
    expect(rows.map((r) => r.id)).toEqual([strong.id, mild.id, hidden.id]);
  });

  it('is empty when there is nothing negative', async () => {
    await seedFact('Follows cycling', [{ text: 'Cycling', weight: 0.5 }]);
    expect(await firstValueFrom(observeNegative())).toEqual([]);
  });
});

describe('weights, priority and status writers', () => {
  it('setWeight clamps to [-1, 1]; setHighPriority; suppress / reactivate / retire', async () => {
    const [row] = await createTopics([{ text: 'x', weight: 0.5 }]);

    await setWeight(row.id, 5);
    expect((await getWeightsByIds([row.id]))[0].weight).toBe(1);
    await setWeight(row.id, -5);
    expect((await getWeightsByIds([row.id]))[0].weight).toBe(-1);

    await setHighPriority(row.id, true);
    await suppress(row.id);
    expect(row).toMatchObject({ highPriority: true, status: 'suppressed' });
    await reactivate(row.id);
    expect(row.status).toBe('active');
    await retire(row.id);
    expect(row.status).toBe('retired');
  });
});

describe('destroyOrphanedTopics: the startup repair', () => {
  it('destroys exactly the topics whose fact is gone, never a live fact\'s or a location topic', async () => {
    const live = await seedFact('Follows cycling', ['Cycling']);
    const dead = await seedFact('Follows chess', ['Chess openings', 'Chess news']);
    const [location] = await createTopics([{ text: 'Rotterdam', weight: 0.5, provenance: 'user' }]);
    await destroyFactRowOnly(dead.fact.id);
    const validFactIds = new Set((await getFacts()).map((f) => f.id));

    const destroyed = await destroyOrphanedTopics(validFactIds);

    expect(destroyed).toBe(2);
    expect(ids(await allTopics())).toEqual(ids([live.topics[0], location]));
  });

  it('is a no-op when every owned topic has a living fact', async () => {
    const a = await seedFact('Follows cycling', ['Cycling']);
    const validFactIds = new Set([a.fact.id]);

    expect(await destroyOrphanedTopics(validFactIds)).toBe(0);
    expect(await allTopics()).toHaveLength(1);
  });
});

describe('repairUnweightedTopics: the startup weight repair', () => {
  it('is a no-op on an empty table', async () => {
    expect(await repairUnweightedTopics()).toBe(0);
  });

  it('lifts exactly the dead shape (active, fact-owned, weight 0, provenance user) to the generated-topic weight, and touches nothing else', async () => {
    const { fact } = await seedFact('Follows Dutch life');
    const [dead] = await seedTopics(fact.id, [{ text: 'dead one', weight: 0, provenance: 'user' }]);
    const [downrank] = await seedTopics(fact.id, [{ text: 'downrank', weight: -0.3, provenance: 'user' }]);
    const [llmZero] = await seedTopics(fact.id, [{ text: 'llm zero', weight: 0, provenance: 'llm' }]);
    const [suppressed] = await seedTopics(fact.id, [{ text: 'suppressed zero', weight: 0, provenance: 'user', status: 'suppressed' }]);
    const [retired] = await seedTopics(fact.id, [{ text: 'retired zero', weight: 0, provenance: 'user', status: 'retired' }]);
    const [factless] = await seedTopics(null, [{ text: 'factless zero', weight: 0, provenance: 'user' }]);

    expect(await repairUnweightedTopics()).toBe(1);

    expect(dead.weight).toBe(DEFAULT_HARNESS_CONFIG.topicGen.llmTopicWeight);
    expect(dead.weight).toBeGreaterThan(0);
    expect(dead.provenance).toBe('llm');
    // A negative weight is the user's own downrank: a repair must not undo it.
    expect(downrank).toMatchObject({ weight: -0.3, provenance: 'user' });
    for (const untouched of [llmZero, suppressed, retired, factless]) {
      expect(untouched.weight).toBe(0);
    }
    expect(factless.provenance).toBe('user');
    // Healed once.
    expect(await repairUnweightedTopics()).toBe(0);
  });
});

describe('normalizeTopicText', () => {
  it('lowercases, trims and collapses inner whitespace', () => {
    expect(normalizeTopicText('  Dutch   POLITICS ')).toBe('dutch politics');
  });
});
