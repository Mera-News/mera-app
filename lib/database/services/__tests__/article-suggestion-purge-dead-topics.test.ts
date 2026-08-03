// article-suggestion-service.purgeSuggestionsForDeadTopics — removes rows that
// survive only because of topics that no longer exist (the other half of the
// fact-deletion cascade; see topic-service.destroyOrphanedTopics).
//
// These assertions are the SAFETY contract, not incidental behaviour: this
// function permanently destroys user-visible rows, so every "leave it alone"
// case below is the guard against deleting content the user should still see.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import { purgeSuggestionsForDeadTopics } from '../article-suggestion-service';

const db = database as any;

function suggestion(
  id: string,
  matched: { topicId: string | null; text: string }[] | null,
  extra: Record<string, unknown> = {},
) {
  return makeRecord({
    id,
    matchedTopicsJson: matched === null ? null : JSON.stringify(matched),
    headlineScope: null,
    prepareDestroyPermanently: jest.fn(() => ({ _destroy: id })),
    ...extra,
  });
}

function joinRow(id: string, articleSuggestionId: string) {
  return makeRecord({
    id,
    articleSuggestionId,
    prepareDestroyPermanently: jest.fn(() => ({ _destroy: id })),
  });
}

describe('purgeSuggestionsForDeadTopics', () => {
  beforeEach(() => {
    (db.batch as jest.Mock).mockClear();
    (db.write as jest.Mock).mockClear();
    db._setRows('article_suggestion_facts', []);
  });

  it('destroys a row whose every matched topic is gone', async () => {
    const dead = suggestion('s-dead', [{ topicId: 't-gone', text: 'nfl' }]);
    db._setRows('article_suggestions', [dead]);

    const count = await purgeSuggestionsForDeadTopics(new Set(['t-live']));

    expect(count).toBe(1);
    expect(dead.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('KEEPS a row when even one matched topic still exists', async () => {
    const mixed = suggestion('s-mixed', [
      { topicId: 't-gone', text: 'nfl' },
      { topicId: 't-live', text: 'ai policy' },
    ]);
    db._setRows('article_suggestions', [mixed]);

    const count = await purgeSuggestionsForDeadTopics(new Set(['t-live']));

    expect(count).toBe(0);
    expect(mixed.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(db.write).not.toHaveBeenCalled();
  });

  it('KEEPS a row with no topic evidence at all (null / empty / synthetic ids)', async () => {
    const noJson = suggestion('s-null', null);
    const empty = suggestion('s-empty', []);
    const synthetic = suggestion('s-synth', [{ topicId: null, text: 'headline match' }]);
    db._setRows('article_suggestions', [noJson, empty, synthetic]);

    const count = await purgeSuggestionsForDeadTopics(new Set());

    expect(count).toBe(0);
    for (const row of [noJson, empty, synthetic]) {
      expect(row.prepareDestroyPermanently).not.toHaveBeenCalled();
    }
  });

  it('KEEPS a top-headline row even when its topics are gone — it has a scope section', async () => {
    const headline = suggestion('s-headline', [{ topicId: 't-gone', text: 'x' }], {
      headlineScope: 'COUNTRY',
    });
    db._setRows('article_suggestions', [headline]);

    const count = await purgeSuggestionsForDeadTopics(new Set());

    expect(count).toBe(0);
    expect(headline.prepareDestroyPermanently).not.toHaveBeenCalled();
  });

  it('destroys the row AND its fact-join rows in one batch, leaving other joins intact', async () => {
    const dead = suggestion('s-dead', [{ topicId: 't-gone', text: 'nfl' }]);
    db._setRows('article_suggestions', [dead]);
    const ownJoin = joinRow('j-1', 's-dead');
    const otherJoin = joinRow('j-2', 's-other');
    db._setRows('article_suggestion_facts', [ownJoin, otherJoin]);

    await purgeSuggestionsForDeadTopics(new Set());

    expect(ownJoin.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    expect(otherJoin.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(db.batch).toHaveBeenCalledWith([{ _destroy: 's-dead' }, { _destroy: 'j-1' }]);
  });

  it('returns 0 without writing when nothing qualifies', async () => {
    db._setRows('article_suggestions', []);

    expect(await purgeSuggestionsForDeadTopics(new Set(['t-live']))).toBe(0);
    expect(db.write).not.toHaveBeenCalled();
  });

  it('never throws — a read failure must not fail the committed fact deletion', async () => {
    db._collections['article_suggestions'].query = jest.fn(() => {
      throw new Error('db exploded');
    });

    await expect(purgeSuggestionsForDeadTopics(new Set())).resolves.toBe(0);
  });
});
