// topic-service.repairUnweightedTopics — the startup repair for topics minted
// without a weight.
//
// `createTopics` used to default `weight` to 0, and `buildRetrievalProfile`
// drops every topic whose effective weight is <= 0 before the feed request is
// built. Measured on device: a Profile showing nine facts and ~100 topics
// where every line read "0 articles", because none of them was ever in a
// query. Three call sites produced them — both "Add topic" buttons since they
// were written, and `completeTopicGeneration` once the topic guidelines were
// wired to the chat route.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import { repairUnweightedTopics } from '../topic-service';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';

const db = database as any;

const deadRow = (id: string) =>
  makeRecord({ id, weight: 0, provenance: 'user', status: 'active', factId: 'f1' });

describe('repairUnweightedTopics', () => {
  beforeEach(() => {
    (db.batch as jest.Mock).mockClear();
    (db.write as jest.Mock).mockClear();
  });

  it('is a no-op, and writes nothing, when there is nothing to heal', async () => {
    db._setRows('topics', []);
    expect(await repairUnweightedTopics()).toBe(0);
    expect(db.write).not.toHaveBeenCalled();
  });

  it('lifts a dead topic to the generated-topic weight', async () => {
    const row = deadRow('t1');
    db._setRows('topics', [row]);

    expect(await repairUnweightedTopics()).toBe(1);

    const patch = (row.prepareUpdate as jest.Mock).mock.calls[0][0];
    const applied: Record<string, unknown> = {};
    patch(applied);
    expect(applied.weight).toBe(DEFAULT_HARNESS_CONFIG.topicGen.llmTopicWeight);
    expect(applied.weight).toBeGreaterThan(0);
    expect(applied.provenance).toBe('llm');
  });

  // THE PREDICATE IS THE SAFETY. A blanket lift of "weight <= 0" would
  // re-enable every topic the user pushed away, which is a choice they made
  // and a repair must not undo.
  it('matches weight EXACTLY 0, never a negative downrank', async () => {
    db._setRows('topics', []);
    await repairUnweightedTopics();

    const clauses = JSON.stringify(
      (db._collections['topics'].query as jest.Mock).mock.calls[0],
    );
    expect(clauses).toContain('weight');
    // Q.where('weight', 0) is an equality; an lt/lte would reach downranks.
    expect(clauses).not.toContain('lt');
    expect(clauses).not.toContain('lte');
  });

  it('only touches active, fact-owned rows carrying BOTH defaults', async () => {
    db._setRows('topics', []);
    await repairUnweightedTopics();

    const args = (db._collections['topics'].query as jest.Mock).mock.calls[0];
    const asJson = JSON.stringify(args);
    for (const needle of ['weight', 'provenance', 'status', 'fact_id']) {
      expect(asJson).toContain(needle);
    }
    expect(args).toHaveLength(4);
  });
});
