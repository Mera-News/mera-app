// topic-service.destroyOrphanedTopics — the startup repair for topics whose
// owning fact is gone (facts deleted before Fact.destroyCascade actually
// cascaded, 2026-08-03). Measured failure mode on a real device: 74 orphaned
// topics kept fetching feed content for deleted interests while the Dashboard
// dropped every suggestion they claimed → permanently empty Dashboard.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import { destroyOrphanedTopics } from '../topic-service';

const db = database as any;

function topicRow(id: string, factId: string | null) {
  return makeRecord({ id, factId, prepareDestroyPermanently: jest.fn(() => `destroy:${id}`) });
}

describe('destroyOrphanedTopics', () => {
  beforeEach(() => {
    (db.batch as jest.Mock).mockClear();
    (db.write as jest.Mock).mockClear();
  });

  it('queries only fact-owned topics (fact_id NOT NULL)', async () => {
    db._setRows('topics', []);
    await destroyOrphanedTopics(new Set());
    const col = db._collections['topics'];
    expect(col.query).toHaveBeenCalledWith(Q.where('fact_id', Q.notEq(null)));
  });

  it('destroys exactly the topics whose fact no longer exists', async () => {
    const keep = topicRow('t-live', 'fact-alive');
    const orphan1 = topicRow('t-orphan-1', 'fact-deleted');
    const orphan2 = topicRow('t-orphan-2', 'fact-deleted-too');
    db._setRows('topics', [keep, orphan1, orphan2]);

    const count = await destroyOrphanedTopics(new Set(['fact-alive']));

    expect(count).toBe(2);
    expect(keep.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(orphan1.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    expect(orphan2.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    expect(db.batch).toHaveBeenCalledWith(['destroy:t-orphan-1', 'destroy:t-orphan-2']);
  });

  it('never touches location topics (fact_id null) even though the fake query returns them', async () => {
    // The real query's NOT-NULL predicate excludes these rows; the fake query
    // ignores predicates, so this doubles as a guard on the in-code filter.
    const locationTopic = topicRow('t-loc', null);
    db._setRows('topics', [locationTopic]);

    const count = await destroyOrphanedTopics(new Set());

    expect(count).toBe(0);
    expect(locationTopic.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(db.write).not.toHaveBeenCalled();
  });

  it('is a no-op (no write) when every owned topic has a living fact', async () => {
    db._setRows('topics', [topicRow('t1', 'f1'), topicRow('t2', 'f2')]);

    const count = await destroyOrphanedTopics(new Set(['f1', 'f2']));

    expect(count).toBe(0);
    expect(db.write).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });
});
