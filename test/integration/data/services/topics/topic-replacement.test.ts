// "Replace, don't just delete": the r12 topic-sanity pass generates replacements FIRST (one
// combo-only call to the gateway mock), then mints them and retires the bad topics in ONE batch.
// Real facts, topics and metadata; the only fault is a key-scoped batch failure (R26).
//
// Replaces:
//   topic-replacement-service.test.ts (9 `it`): a rejecting batch call changes nothing; a result
//     carrying an error changes nothing; an empty batch changes nothing; an unknown fact changes
//     nothing; generate, replace, then sync the legacy metadata; ONE combo-only call with thinking
//     on; excludes a text a tracked topic holds; surfaces floorHeld; unparseable output still reaches
//     the floor
//   topic-replacement-atomicity.test.ts (11 `it`): (b) one write and one batch with both operations;
//     flips the retired rows in that batch; mints llm at the reduced weight; writes nothing when
//     there is neither; (c) withholds the retire when all are bad and nothing came back; allows it
//     when replacements cover; allows it when another topic survives; still mints while the retire is
//     withheld; counts only ACTIVE rows toward the floor; ignores ids that are not active; ignores
//     ids of another fact
//
// Not carried over: "an empty batch changes nothing" (the `!result` guard it covered is gone: the
// gateway mock answers one result row per call, success or failure). "Still mints even while the retire is
// withheld" is vacuous (the floor is only held when nothing was planned, so there is nothing to mint);
// here the held floor asserts an empty mint. "One database.write" / "one database.batch" are asserted
// by the batch fault. A result carrying an error uses the mock's per-item failure.
//
// B3 (DATA-U8-1): see the end of the file.
import { Q } from '@nozbe/watermelondb';

import { addFact } from '@/lib/database/services/fact-service';
import { generateAndReplace } from '@/lib/database/services/topic-replacement-service';
import {
  createTopics,
  getByFact,
  normalizeTopicText,
  replaceTopicsForFact,
  retire,
} from '@/lib/database/services/topic-service';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { advanceUntilDone, gatewayCalls, mockGateway, server, signInFixtureAccount, useFakeClock } from '@/test/helpers';

import {
  cleanupTopics,
  countRows,
  failBatchWhere,
  metadataTopics,
  resetCloudMemory,
  resetTopicsMemory,
  seedFact,
  seedTopics,
  watchBodies,
} from './support';

const T0 = Date.parse('2026-10-09T10:00:00Z');
const CRICKET = 'Follows the Indian national cricket team';
const BAD = 'Amsterdam cricket festival music tech';
const OK = 'India cricket news';
const TOPUP_WEIGHT = DEFAULT_HARNESS_CONFIG.topicGen.topupTopicWeight;

beforeEach(async () => {
  resetTopicsMemory();
  resetCloudMemory();
  await signInFixtureAccount();
  useFakeClock(T0);
});
afterEach(cleanupTopics);

const reply = (text: string) => server.use(...mockGateway(() => text));
const replace = (...args: Parameters<typeof generateAndReplace>) => advanceUntilDone(generateAndReplace(...args));

/** The cricket fact with one contaminated and one good topic, plus a second fact to combine with. */
async function cricketWorld() {
  const { fact, topics } = await seedFact(CRICKET, [BAD, OK]);
  await addFact('Lives in Amsterdam');
  return { fact, bad: topics[0], ok: topics[1] };
}

const activeTexts = async (factId: string) =>
  (await getByFact(factId)).filter((t) => t.status === 'active').map((t) => t.text).sort();

describe('generateAndReplace: a failed generation changes NOTHING', () => {
  it('a refused batch call leaves every topic and the metadata list as they were', async () => {
    const { fact, bad } = await cricketWorld();
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'nope' } })));

    const out = await replace(fact.id, 3, [bad.id]);

    expect(out).toEqual({ ok: false, minted: 0, retired: 0, floorHeld: false });
    expect(await activeTexts(fact.id)).toEqual([OK, BAD].sort());
    expect(await metadataTopics(fact.id)).toEqual([BAD, OK]);
  });

  it('a result carrying an error (one item of the batch failed upstream) changes nothing', async () => {
    const { fact, bad } = await cricketWorld();
    server.use(...mockGateway(() => ({ status: 502, body: { error: 'reasoning-overran-budget' }, perItem: true })));

    const out = await replace(fact.id, 3, [bad.id]);

    expect(out).toEqual({ ok: false, minted: 0, retired: 0, floorHeld: false });
    expect(gatewayCalls('batch')).toHaveLength(1);
    expect(await activeTexts(fact.id)).toEqual([OK, BAD].sort());
    expect(await metadataTopics(fact.id)).toEqual([BAD, OK]);
  });

  it('an unknown fact changes nothing and asks no model', async () => {
    await cricketWorld();

    const out = await replace('ghost', 3, ['t']);

    expect(out.ok).toBe(false);
    expect(gatewayCalls()).toHaveLength(0);
    expect(await countRows('topics')).toBe(2);
  });
});

describe('generateAndReplace: generate, then mint and retire together', () => {
  it('mints the replacement, retires the bad topic, and keeps the metadata list in step (table AND metadata)', async () => {
    const { fact, bad, ok } = await cricketWorld();
    reply('["Netherlands cricket diaspora broadcasts"]');

    const out = await replace(fact.id, 3, [bad.id]);

    expect(out).toEqual({ ok: true, minted: 1, retired: 1, floorHeld: false });
    const rows = await getByFact(fact.id);
    expect(rows.find((r) => r.id === bad.id)?.status).toBe('retired');
    expect(rows.find((r) => r.id === ok.id)?.status).toBe('active');
    const minted = rows.find((r) => r.text === 'Netherlands cricket diaspora broadcasts')!;
    expect(minted).toMatchObject({ status: 'active', provenance: 'llm', weight: TOPUP_WEIGHT, factId: fact.id });
    // The legacy list (still read by unmigrated devices) gets the new text appended.
    expect(await metadataTopics(fact.id)).toEqual([BAD, OK, 'Netherlands cricket diaspora broadcasts']);
  });

  it('issues exactly ONE combo-only call, thinking on, for the fact asked about', async () => {
    const { fact, bad } = await cricketWorld();
    reply('["Netherlands cricket diaspora broadcasts"]');
    const bodies = watchBodies('/v1/chat/completions/batch');

    await replace(fact.id, 3, [bad.id]);

    expect(gatewayCalls('batch')).toHaveLength(1);
    expect(gatewayCalls('batch')[0].messages[0].content).toContain('combine the Fact');
    expect(gatewayCalls('batch')[0].messages[1].content).toContain(CRICKET);
    const [body] = await bodies.bodies();
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].chat_template_kwargs.enable_thinking).toBe(true);
  });

  it('EXCLUDES a text a tracked topic already holds: no row is minted for it, and the retire still lands', async () => {
    const { fact, bad } = await cricketWorld();
    const [tracked] = await createTopics([
      { text: 'Netherlands cricket diaspora broadcasts', weight: 0.85, provenance: 'tracked', status: 'active' },
    ]);
    reply('["Netherlands cricket diaspora broadcasts"]');

    const out = await replace(fact.id, 3, [bad.id]);

    expect(out).toEqual({ ok: true, minted: 0, retired: 1, floorHeld: false });
    expect(await countRows('topics')).toBe(3); // the tracked row stays the only holder of that text
    expect(tracked.provenance).toBe('tracked');
    expect(await metadataTopics(fact.id)).toEqual([BAD, OK]);
  });

  it('surfaces floorHeld so the caller does not claim a cleanup that did not happen', async () => {
    const { fact, topics } = await seedFact(CRICKET, [BAD]);
    await addFact('Lives in Amsterdam');
    reply('[]');

    const out = await replace(fact.id, 3, [topics[0].id]);

    expect(out).toEqual({ ok: true, minted: 0, retired: 0, floorHeld: true });
    expect(await activeTexts(fact.id)).toEqual([BAD]);
  });

  it('unparseable model output still reaches the floor instead of failing open', async () => {
    const { fact, topics } = await seedFact(CRICKET, [BAD]);
    await addFact('Lives in Amsterdam');
    reply('not json at all');

    const out = await replace(fact.id, 3, [topics[0].id]);

    expect(out).toEqual({ ok: true, minted: 0, retired: 0, floorHeld: true });
    expect(await activeTexts(fact.id)).toEqual([BAD]);
  });

  it('with no candidate to generate for (already at target), asks no model and retires safely while another topic survives', async () => {
    const { fact, bad } = await cricketWorld();

    const out = await replace(fact.id, 1, [bad.id]);

    expect(gatewayCalls()).toHaveLength(0);
    expect(out).toEqual({ ok: true, minted: 0, retired: 1, floorHeld: false });
    expect(await activeTexts(fact.id)).toEqual([OK]);
  });

  it('with no candidate and nothing left to keep, holds the floor', async () => {
    const { fact, bad, ok } = await cricketWorld();

    const out = await replace(fact.id, 0, [bad.id, ok.id]);

    expect(gatewayCalls()).toHaveLength(0);
    expect(out).toEqual({ ok: true, minted: 0, retired: 0, floorHeld: true });
    expect(await activeTexts(fact.id)).toEqual([OK, BAD].sort());
  });
});

describe('replaceTopicsForFact: mint and retire land in a SINGLE batch', () => {
  const plan = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ text: `replacement ${i}`, normalizedText: `replacement ${i}` }));

  async function world() {
    const { fact, topics } = await seedFact(CRICKET, ['good', 'bad1', 'bad2']);
    return { fact, good: topics[0], bad1: topics[1], bad2: topics[2] };
  }

  it('mints llm rows at the reduced top-up weight and retires the named rows', async () => {
    const { fact, bad1, bad2 } = await world();

    const res = await replaceTopicsForFact(fact.id, plan(2), [bad1.id, bad2.id]);

    expect(res.floorHeld).toBe(false);
    expect(res.retired.sort()).toEqual([bad1.id, bad2.id].sort());
    expect(res.minted.map((m) => [m.provenance, m.weight, m.factId, m.status])).toEqual([
      ['llm', 0.5, fact.id, 'active'],
      ['llm', 0.5, fact.id, 'active'],
    ]);
    expect(bad1.status).toBe('retired');
    expect(bad2.status).toBe('retired');
    expect(await countRows('topics')).toBe(5);
  });

  it('is ONE batch: when the retire cannot land, the mint does not either', async () => {
    const { fact, bad1 } = await world();
    failBatchWhere((op) => op.table === 'topics' && op.raw.status === 'retired');

    await expect(replaceTopicsForFact(fact.id, plan(2), [bad1.id])).rejects.toThrow('batch failed (injected)');

    // Adapter-level counts: nothing minted, nothing retired.
    expect(await countRows('topics')).toBe(3);
    expect(await countRows('topics', Q.where('status', 'retired'))).toBe(0);
  });

  it('writes nothing at all when there is neither a mint nor a retire', async () => {
    const { fact } = await world();

    const res = await replaceTopicsForFact(fact.id, [], []);

    expect(res).toEqual({ minted: [], retired: [], floorHeld: false });
    expect(await countRows('topics')).toBe(3);
  });

  describe('the floor: a fact never goes dark', () => {
    it('WITHHOLDS the retire when nothing came back and every active topic is named', async () => {
      const { fact, topics } = await seedFact(CRICKET, ['only']);

      const res = await replaceTopicsForFact(fact.id, [], [topics[0].id]);

      expect(res).toEqual({ minted: [], retired: [], floorHeld: true });
      expect(topics[0].status).toBe('active');
    });

    it('ALLOWS the retire when replacements cover the loss', async () => {
      const { fact, topics } = await seedFact(CRICKET, ['only']);

      const res = await replaceTopicsForFact(fact.id, plan(1), [topics[0].id]);

      expect(res.floorHeld).toBe(false);
      expect(res.retired).toEqual([topics[0].id]);
    });

    it('ALLOWS the retire when another active topic survives', async () => {
      const { fact, bad1 } = await world();

      const res = await replaceTopicsForFact(fact.id, [], [bad1.id]);

      expect(res.floorHeld).toBe(false);
      expect(res.retired).toEqual([bad1.id]);
    });

    it('counts only ACTIVE rows toward the floor: retired siblings do not make it safe', async () => {
      const { fact, topics } = await seedFact(CRICKET, ['bad1', { text: 'old1', status: 'retired' }, { text: 'old2', status: 'retired' }]);

      const res = await replaceTopicsForFact(fact.id, [], [topics[0].id]);

      expect(res.floorHeld).toBe(true);
      expect(topics[0].status).toBe('active');
    });
  });

  describe('retire targeting', () => {
    it('ignores ids that are not active (already retired)', async () => {
      const { fact, topics } = await seedFact(CRICKET, ['good', { text: 'already', status: 'retired' }]);

      const res = await replaceTopicsForFact(fact.id, plan(1), [topics[1].id]);

      expect(res.retired).toEqual([]);
      expect(res.minted).toHaveLength(1);
    });

    it('ignores ids that belong to another fact', async () => {
      const { fact } = await world();
      const other = await seedTopics((await addFact('Plays chess')).id, ['Chess openings']);

      const res = await replaceTopicsForFact(fact.id, plan(1), [other[0].id]);

      expect(res.retired).toEqual([]);
      expect(other[0].status).toBe('active');
    });
  });
});

// ---------------------------------------------------------------------------
// B3 (DATA-U8-1): fact-service.appendFactMetadataTopics and the topics table both dedupe with
// `normalizeTopicText` (which also collapses inner whitespace), so "Dutch  politics" does not land
// beside "dutch politics" in `fact.metadata.topics`.
//
// REACHABLE STATE: a fact whose `metadata.topics` holds a text the table has no row for. The
// persona-v3 migration leaves exactly that on a legacy fact (metadata-only topics), written here
// through `addFact(statement, { topics })`; the fact also has one topic row, because the top-up only
// considers facts that already have one. A plain `retire` does NOT produce the state: a retired row
// stays in the table and `getAllNormalizedTexts` still counts it, so the plan excludes the text and
// nothing is appended (the last test pins that). `flushPendingDeletes` prunes the metadata, so it
// cannot leave the text behind either.
// ---------------------------------------------------------------------------

describe('B3: the metadata append dedupes on the same key as the table', () => {
  /** A legacy fact: "dutch politics" only in metadata.topics, one real topic row, and a second fact to combine with. */
  async function legacyFact() {
    const fact = await addFact(CRICKET, { topics: ['dutch politics'] });
    await seedTopics(fact.id, [OK]);
    await addFact('Lives in Amsterdam');
    return fact;
  }

  const keys = (texts: string[]) => texts.map(normalizeTopicText);

  it('B3: the metadata list holds no two entries with the same normalizeTopicText key', async () => {
    const fact = await legacyFact();
    reply('["Dutch  politics"]');

    const out = await replace(fact.id, 3, []);

    expect(out).toMatchObject({ ok: true, minted: 1 });
    const topics = keys(await metadataTopics(fact.id));
    expect(new Set(topics).size).toBe(topics.length);
  });

  it('B3 boundary: a RETIRED row keeps its text in the table, so the plan excludes it and nothing is appended', async () => {
    const fact = await addFact(CRICKET);
    const [dutch] = await seedTopics(fact.id, ['dutch politics', OK]);
    await retire(dutch.id);
    await addFact('Lives in Amsterdam');
    reply('["Dutch  politics"]');

    const out = await replace(fact.id, 3, []);

    expect(out).toEqual({ ok: true, minted: 0, retired: 0, floorHeld: false });
    expect(await metadataTopics(fact.id)).toEqual(['dutch politics', OK]);
  });
});
