// findSimilarFacts on real facts: it RANKS by token overlap and judges nothing, so there is no score
// floor and no hard filter on kind.
//
// Replaces fact-similarity-service.test.ts (all 10 `it`): exact duplicate scores 1; agrees with
// filterNewFacts on what a duplicate is; ranks the more-overlapping fact first; an equal-overlap tie
// goes to the same kind; kind is not a hard filter; no score floor; a short list is returned whole;
// limit; no content tokens; an unrelated fact scores 0.
import { addFact } from '@/lib/database/services/fact-service';
import { findSimilarFacts } from '@/lib/database/services/fact-similarity-service';
import { filterNewFacts } from '@/lib/news-harness/persona-management/fact-rules';

import { cleanupTopics, resetTopicsMemory } from './support';

beforeEach(resetTopicsMemory);
afterEach(cleanupTopics);

const fact = (statement: string, attribute?: string) =>
  addFact(statement, undefined, attribute ? { attribute } : undefined);

describe('findSimilarFacts', () => {
  it('scores an exact duplicate 1 and returns it', async () => {
    const f = await fact('I live in Rotterdam');

    const [top] = await findSimilarFacts(null, 'I live in Rotterdam');

    expect(top).toMatchObject({ id: f.id, statement: 'I live in Rotterdam', score: 1, sameKind: false, questionnaireAttribute: null });
  });

  it('agrees with filterNewFacts on what counts as a duplicate', async () => {
    // A score of 1 is only actionable if the harness would reject the statement outright.
    const existing = 'I live in Rotterdam';
    await fact(existing);
    const candidate = '  i   LIVE in rotterdam ';

    const [top] = await findSimilarFacts(null, candidate);
    const { rejected } = filterNewFacts([candidate], [existing]);

    expect(top.score).toBe(1);
    expect(rejected[0]?.reason).toBe('duplicate');
  });

  it('ranks the more-overlapping fact first', async () => {
    await fact('I enjoy baking sourdough bread');
    const near = await fact('I follow Dutch politics closely');

    const out = await findSimilarFacts(null, 'I follow Dutch politics');

    expect(out[0].id).toBe(near.id);
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it('breaks an equal-overlap tie toward the same kind (and adds the same-kind bonus)', async () => {
    await fact('I follow Dutch politics', 'hobby');
    const same = await fact('I follow Dutch politics', 'interest');

    const out = await findSimilarFacts('interest', 'I follow Dutch politics');

    expect(out[0]).toMatchObject({ id: same.id, sameKind: true, questionnaireAttribute: 'interest' });
    expect(out[1].sameKind).toBe(false);
    expect(out[0].score).toBe(1); // clamped: the bonus never pushes past 1
  });

  it('does NOT hard-filter by kind: a cross-kind duplicate still comes back', async () => {
    const f = await fact('I live in Rotterdam', 'residence');

    const out = await findSimilarFacts('employment', 'I live in Rotterdam');

    expect(out.map((r) => r.id)).toEqual([f.id]);
    expect(out[0].sameKind).toBe(false);
  });

  it('has NO score floor: weak matches are returned, ranked, for the caller to judge', async () => {
    await fact('I enjoy baking sourdough bread on Sundays');

    const out = await findSimilarFacts(null, 'Dutch politics bread');

    expect(out).toHaveLength(1);
    expect(out[0].score).toBeGreaterThan(0);
    expect(out[0].score).toBeLessThan(0.3);
  });

  it('scores an unrelated fact 0 rather than omitting it', async () => {
    await fact('sourdough baking');

    const out = await findSimilarFacts(null, 'Dutch politics');

    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(0);
  });

  it('returns everything, ordered, when the fact list is shorter than the limit; honours the limit', async () => {
    await fact('a b c');
    await fact('x y z');
    expect(await findSimilarFacts(null, 'a b c', 5)).toHaveLength(2);

    await fact('Dutch politics one');
    await fact('Dutch politics two');
    await fact('Dutch politics three');
    expect(await findSimilarFacts(null, 'Dutch politics', 2)).toHaveLength(2);
  });

  it('returns [] when the statement has no content tokens, and for a zero limit', async () => {
    await fact('I live in Rotterdam');

    expect(await findSimilarFacts(null, '   ')).toEqual([]);
    expect(await findSimilarFacts(null, 'i the a of and or')).toEqual([]);
    expect(await findSimilarFacts(null, 'x', 0)).toEqual([]);
  });
});
