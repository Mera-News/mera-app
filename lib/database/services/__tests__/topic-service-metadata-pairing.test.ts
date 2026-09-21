/**
 * `fact.metadata.topics` is a SECOND topic list with its own reader: the facts
 * screen renders it while the chat card renders the `topics` table, and
 * `fetchTopicIdsLegacy` still retrieves from it. `createTopics` keeps the two
 * in step so no caller has to remember.
 */
jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), captureException: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../news-harness/persona-management/topic-generation', () => ({
  planLlmTopicRows: jest.fn(() => []),
}));

import database from '@/lib/database/index';
import { makeRecord, type MockDatabase } from '@/lib/__test-helpers__/mockDatabase';
import { createTopics } from '../topic-service';

const db = database as unknown as MockDatabase;

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('topics', []);
  db._setRows('facts', []);
});

describe('createTopics keeps both topic readers in step', () => {
  it('a DIRECT call updates the table AND fact.metadata.topics in one batch', async () => {
    // The named regression: "Add topic", the re-mint after a decline is
    // lifted, and generate-more all reach createTopics with no wrapper. If
    // the pairing lived in a wrapper, all three would bypass it.
    const fact = makeRecord({ id: 'f1', metadata: { topics: ['Cycling'] } });
    db._setRows('facts', [fact]);

    await createTopics([{ factId: 'f1', text: 'Dutch Politics', weight: 0.75 }]);

    expect(db._collections['topics'].prepareCreate).toHaveBeenCalledTimes(1);
    expect(fact.metadata.topics).toEqual(['Cycling', 'Dutch Politics']);
    // ONE batch, so a crash cannot leave the two screens disagreeing.
    expect(db.batch).toHaveBeenCalledTimes(1);
    const ops = await db.batch.mock.results[0].value;
    expect(ops).toHaveLength(2); // the topic + the fact update
  });

  it('an input with NO factId writes no fact row at all', async () => {
    // THIS is the invariant that keeps negative topics (provenance
    // 'feedback') and tracked-story topics off the facts screen — not the
    // survey fact that today's callers happen to pass no factId, which a new
    // caller can falsify. It holds whatever future callers do.
    const fact = makeRecord({ id: 'f1', metadata: { topics: ['Cycling'] } });
    db._setRows('facts', [fact]);

    await createTopics([{ text: 'Some Disliked Thing', provenance: 'feedback', weight: 0.75 }]);

    expect(fact.prepareUpdate).not.toHaveBeenCalled();
    expect(fact.metadata.topics).toEqual(['Cycling']);
    const ops = await db.batch.mock.results[0].value;
    expect(ops).toHaveLength(1); // the topic only
  });

  it('preserves sibling metadata keys — the wholesale-assign trap', async () => {
    // Fact.updateFact assigns `metadata` WHOLESALE, so writing `{ topics }`
    // alone would silently drop these.
    const fact = makeRecord({
      id: 'f1',
      metadata: { topics: [], topicGenError: ['boom'], topicsReviewedAt: ['t'] },
    });
    db._setRows('facts', [fact]);

    await createTopics([{ factId: 'f1', text: 'New Topic', weight: 0.75 }]);

    expect(fact.metadata.topicGenError).toEqual(['boom']);
    expect(fact.metadata.topicsReviewedAt).toEqual(['t']);
    expect(fact.metadata.topics).toEqual(['New Topic']);
  });

  it('does not duplicate a text already in metadata (case-insensitively)', async () => {
    const fact = makeRecord({ id: 'f1', metadata: { topics: ['Dutch Politics'] } });
    db._setRows('facts', [fact]);

    await createTopics([{ factId: 'f1', text: 'dutch  politics', weight: 0.75 }]);

    expect(fact.metadata.topics).toEqual(['Dutch Politics']);
  });

  it('excludes staged rows from its dedup query — never resolves a doomed row', async () => {
    // createTopics is resolve-or-create and four call sites treat the result
    // as live; handing back a row flushPendingDeletes is about to destroy
    // would bind a tracked story to a doomed topic id. The mock ignores
    // predicates, so assert the QUERY.
    await createTopics([{ factId: 'f1', text: 'X', weight: 0.75 }]);
    const args = db._collections['topics'].query.mock.calls[0];
    expect(JSON.stringify(args)).toContain('pending_delete_at');
  });
});
