jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import database from '@/lib/database/index';
import { makeRecord, type MockDatabase } from '@/lib/__test-helpers__/mockDatabase';
import { findSimilarFacts } from '../fact-similarity-service';
import { filterNewFacts } from '@/lib/news-harness/persona-management/fact-rules';

const db = database as unknown as MockDatabase;

const fact = (id: string, statement: string, attr: string | null = null) =>
  makeRecord({ id, statement, questionnaireAttribute: attr });

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('facts', []);
});

describe('findSimilarFacts', () => {
  it('scores an exact duplicate 1.0 and returns it', async () => {
    db._setRows('facts', [fact('f1', 'I live in Rotterdam')]);
    const [top] = await findSimilarFacts(null, 'I live in Rotterdam');
    expect(top.id).toBe('f1');
    expect(top.score).toBe(1);
  });

  it('agrees with filterNewFacts on what counts as a duplicate', async () => {
    // The property that makes a score of 1 actionable: it means the harness
    // would reject the statement outright. Both sides normalise identically.
    const existing = 'I live in Rotterdam';
    db._setRows('facts', [fact('f1', existing)]);

    const [top] = await findSimilarFacts(null, '  i   LIVE in rotterdam ');
    const { rejected } = filterNewFacts(['  i   LIVE in rotterdam '], [existing]);

    expect(top.score).toBe(1);
    expect(rejected[0]?.reason).toBe('duplicate');
  });

  it('ranks the more-overlapping fact first', async () => {
    db._setRows('facts', [
      fact('far', 'I enjoy baking sourdough bread'),
      fact('near', 'I follow Dutch politics closely'),
    ]);
    const out = await findSimilarFacts(null, 'I follow Dutch politics');
    expect(out[0].id).toBe('near');
  });

  it('breaks an equal-overlap tie toward the same kind', async () => {
    db._setRows('facts', [
      fact('other', 'I follow Dutch politics', 'hobby'),
      fact('same', 'I follow Dutch politics', 'interest'),
    ]);
    const out = await findSimilarFacts('interest', 'I follow Dutch politics');
    expect(out[0].id).toBe('same');
    expect(out[0].sameKind).toBe(true);
    expect(out[1].sameKind).toBe(false);
  });

  it('does NOT hard-filter by kind — a cross-kind duplicate still comes back', async () => {
    // The duplicate worth finding is often the one saved under a different
    // attribute; filtering by kind would hide exactly that.
    db._setRows('facts', [fact('f1', 'I live in Rotterdam', 'residence')]);
    const out = await findSimilarFacts('employment', 'I live in Rotterdam');
    expect(out.map((f) => f.id)).toContain('f1');
  });

  it('has NO score floor — weak matches are returned, ranked, for the caller to judge', async () => {
    // A floor would make "nothing was similar" indistinguishable from
    // "something scored just under the line".
    db._setRows('facts', [fact('weak', 'I enjoy baking sourdough bread on Sundays')]);
    const out = await findSimilarFacts(null, 'Dutch politics bread');
    expect(out).toHaveLength(1);
    expect(out[0].score).toBeGreaterThan(0);
    expect(out[0].score).toBeLessThan(0.3);
  });

  it('returns everything, ordered, when the fact list is shorter than limit', async () => {
    db._setRows('facts', [fact('f1', 'a b c'), fact('f2', 'x y z')]);
    expect(await findSimilarFacts(null, 'a b c', 5)).toHaveLength(2);
  });

  it('honours limit', async () => {
    db._setRows('facts', [
      fact('f1', 'Dutch politics one'),
      fact('f2', 'Dutch politics two'),
      fact('f3', 'Dutch politics three'),
    ]);
    expect(await findSimilarFacts(null, 'Dutch politics', 2)).toHaveLength(2);
  });

  it('returns [] when the statement has no content tokens at all', async () => {
    // Only for a genuinely empty needle. The stopword list is deliberately
    // short — an aggressive one would strip the content words out of short
    // statements like "I live in Rome" and collapse unrelated facts onto the
    // same token set — so "I am in the a of" still carries "am" and is
    // ranked (at a low score) rather than discarded.
    db._setRows('facts', [fact('f1', 'I live in Rotterdam')]);
    expect(await findSimilarFacts(null, '   ')).toEqual([]);
    expect(await findSimilarFacts(null, 'i the a of and or')).toEqual([]);
    expect(await findSimilarFacts(null, 'x', 0)).toEqual([]);
  });

  it('scores an unrelated fact 0 rather than omitting it', async () => {
    db._setRows('facts', [fact('f1', 'sourdough baking')]);
    const out = await findSimilarFacts(null, 'Dutch politics');
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(0);
  });
});
