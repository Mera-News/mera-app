// topic-service.observeNegative (P3) — the query behind the Not-interested
// screen's "topics you don't want" section.
//
// TESTING NOTE: the fake WatermelonDB collection's `query()` deliberately
// IGNORES its predicate and returns whatever rows the test set (see
// lib/__test-helpers__/mockDatabase.ts). A row-based assertion here would
// therefore be green no matter what the WHERE says — it would prove nothing.
// So this asserts on the CLAUSES handed to `query()`, built with the real `Q`
// (pure data, safe to import), which is the only thing that can actually catch
// a wrong predicate.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database/index';
import { observeNegative } from '../topic-service';

const db = database as any;

/** The fake collection has no observe() — give the query handle one. */
function stubObserve(table: string) {
  const col = db._collections[table];
  const sentinel = { __observable: true };
  col.query = jest.fn(() => ({ observe: jest.fn(() => sentinel) }));
  return { col, sentinel };
}

describe('observeNegative', () => {
  it('selects negative-weight ACTIVE topics OR any SUPPRESSED topic, weight ascending', () => {
    const { col, sentinel } = stubObserve('topics');

    const result = observeNegative();

    expect(result).toBe(sentinel);
    // Asserted as a SET of clauses, not by position: v55 added a
    // `pending_delete_at` filter and a positional assertion turned that into
    // a failure about sort order, which points at the wrong thing.
    expect(col.query).toHaveBeenCalledWith(
      Q.or(
        Q.and(Q.where('status', 'active'), Q.where('weight', Q.lt(0))),
        Q.where('status', 'suppressed'),
      ),
      Q.where('pending_delete_at', null),
      Q.sortBy('weight', Q.asc),
    );
  });

  it('does not select retired topics, and does not select zero/positive active ones', () => {
    const { col } = stubObserve('topics');
    observeNegative();

    // Serialize the clauses and assert on what the predicate can/cannot admit.
    const clauses = JSON.stringify(col.query.mock.calls[0]);
    expect(clauses).toContain('suppressed');
    expect(clauses).not.toContain('retired');
    // Strictly-less-than zero: a 0-weight active topic is neutral, not negative.
    expect(clauses).toContain('lt');
    expect(clauses).not.toContain('lte');
    // v55: a topic staged for deletion must not render in the negative list.
    expect(clauses).toContain('pending_delete_at');
  });

  it('sorts ascending so the strongest dislike comes first', () => {
    const { col } = stubObserve('topics');
    observeNegative();

    // Found, not indexed — a new clause must not be able to break this into
    // a misleading failure about sorting.
    const clauses = col.query.mock.calls[0];
    expect(clauses).toContainEqual(Q.sortBy('weight', Q.asc));
    expect(clauses).not.toContainEqual(Q.sortBy('weight', Q.desc));
  });
});
