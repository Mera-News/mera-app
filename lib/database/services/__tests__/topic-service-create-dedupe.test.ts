// topic-service.createTopics — the dedupe floor (r12 P0).
//
// `normalized_text` is documented as "the dedup + article-match key", but this
// writer used to prepareCreate unconditionally, so any caller that ran twice
// minted a second identical row. Duplicates are independently retrieved AND
// independently billed on every feed sync.
//
// The two properties that make the floor safe are asserted here:
//   • resolve-or-create, never filter — four call sites destructure
//     `const [created] = await createTopics([...])` and treat a hole as a hard
//     failure (a NULL tracked-story topic_id silently stops a followed story).
//   • the key is (normalized_text, fact_id), NOT normalized_text alone — the
//     hygiene duplicate_facts detector finds near-duplicate facts precisely by
//     looking for one text owned by >= 2 facts.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import {
  createTopics,
  getAllNormalizedTexts,
  appendTopupTopicsForFact,
} from '../topic-service';

const db = database as any;

function existing(
  id: string,
  normalizedText: string,
  factId: string | null = null,
  status: 'active' | 'suppressed' | 'retired' = 'active',
) {
  return makeRecord({ id, normalizedText, factId, status, text: normalizedText });
}

/** Rows the collection will return for the "already exists" lookup. */
function seed(rows: any[]) {
  db._setRows('topics', rows);
}

describe('createTopics — dedupe floor', () => {
  beforeEach(() => {
    (db.batch as jest.Mock).mockClear();
    (db.write as jest.Mock).mockClear();
    seed([]);
  });

  it('returns [] and does not write for an empty input', async () => {
    const out = await createTopics([]);
    expect(out).toEqual([]);
    expect(db.write).not.toHaveBeenCalled();
  });

  it('creates a row when nothing matches', async () => {
    const out = await createTopics([{ text: 'Bhopal news' }]);

    expect(out).toHaveLength(1);
    expect(out[0].normalizedText).toBe('bhopal news');
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it('RETURNS the existing row instead of creating a duplicate', async () => {
    const row = existing('t-1', 'bhopal news');
    seed([row]);

    const out = await createTopics([{ text: 'Bhopal News' }]);

    // Resolve-or-create: the caller still gets a row (never undefined)...
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('t-1');
    // ...but nothing new was written.
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.write).not.toHaveBeenCalled();
  });

  it('normalizes case and whitespace when matching', async () => {
    seed([existing('t-1', 'bhopal news')]);

    const out = await createTopics([{ text: '  BHOPAL   news  ' }]);

    expect(out[0].id).toBe('t-1');
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('treats a suppressed row as live — it blocks a duplicate create', async () => {
    seed([existing('t-sup', 'bhopal news', null, 'suppressed')]);

    const out = await createTopics([{ text: 'Bhopal news' }]);

    expect(out[0].id).toBe('t-sup');
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('does NOT let a retired row block a create (retired is exempt)', async () => {
    seed([existing('t-retired', 'bhopal news', null, 'retired')]);

    const out = await createTopics([{ text: 'Bhopal news' }]);

    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(out[0].id).not.toBe('t-retired');
  });

  describe('key is (normalized_text, fact_id)', () => {
    it('still creates the same text under a DIFFERENT fact', async () => {
      // This is what the hygiene duplicate_facts detector needs: one normalized
      // text owned by two facts. A global key would collapse it and delete the
      // signal.
      seed([existing('t-a', 'ai regulation', 'fact-A')]);

      const out = await createTopics([{ text: 'AI regulation', factId: 'fact-B' }]);

      expect(db.batch).toHaveBeenCalledTimes(1);
      expect(out).toHaveLength(1);
      expect(out[0].factId).toBe('fact-B');
      expect(out[0].id).not.toBe('t-a');
    });

    it('dedupes the same text under the SAME fact', async () => {
      seed([existing('t-a', 'ai regulation', 'fact-A')]);

      const out = await createTopics([{ text: 'AI regulation', factId: 'fact-A' }]);

      expect(out[0].id).toBe('t-a');
      expect(db.batch).not.toHaveBeenCalled();
    });

    it('does not match a fact-owned row against an unowned (fact_id null) input', async () => {
      seed([existing('t-a', 'ai regulation', 'fact-A')]);

      const out = await createTopics([{ text: 'AI regulation' }]);

      expect(db.batch).toHaveBeenCalledTimes(1);
      expect(out[0].factId).toBeNull();
    });
  });

  describe('intra-batch duplicates', () => {
    it('collapses repeats within one batch to a single create', async () => {
      const out = await createTopics([
        { text: 'Bhopal news' },
        { text: 'bhopal NEWS' },
        { text: 'Amsterdam news' },
      ]);

      // One row per input, in order — the repeat resolves to the same record.
      expect(out).toHaveLength(3);
      expect(out[0]).toBe(out[1]);
      expect(out[2].normalizedText).toBe('amsterdam news');

      // Only two rows were actually prepared (batch is called with one array).
      const prepared = (db.batch as jest.Mock).mock.calls[0][0];
      expect(prepared).toHaveLength(2);
      expect(prepared.map((r: any) => r.normalizedText)).toEqual([
        'bhopal news',
        'amsterdam news',
      ]);
    });

    it('preserves input order when some resolve and some are created', async () => {
      seed([existing('t-mid', 'second')]);

      const out = await createTopics([
        { text: 'first' },
        { text: 'Second' },
        { text: 'third' },
      ]);

      expect(out).toHaveLength(3);
      expect(out[0].normalizedText).toBe('first');
      expect(out[1].id).toBe('t-mid');
      expect(out[2].normalizedText).toBe('third');
    });
  });

  describe('caller contract — never an undefined hole', () => {
    it('always yields one defined row per input', async () => {
      seed([existing('t-1', 'alpha'), existing('t-2', 'beta')]);

      const out = await createTopics([
        { text: 'alpha' },
        { text: 'gamma' },
        { text: 'beta' },
      ]);

      expect(out).toHaveLength(3);
      for (const row of out) expect(row).toBeDefined();
      // The `const [created] = ...` destructure at four call sites gets a row.
      expect(out[0].id).toBe('t-1');
    });

    it('carries the requested fields onto a newly created row', async () => {
      const out = await createTopics([
        {
          text: 'Tracked story',
          weight: 0.9,
          status: 'active',
          provenance: 'tracked',
          highPriority: true,
        },
      ]);

      expect(out[0].weight).toBe(0.9);
      expect(out[0].provenance).toBe('tracked');
      expect(out[0].highPriority).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// r12 J-P2 — top-up read/write surface
// ---------------------------------------------------------------------------

describe('getAllNormalizedTexts — the GLOBAL exclusion set', () => {
  beforeEach(() => {
    (db.batch as jest.Mock).mockClear();
    (db.write as jest.Mock).mockClear();
  });

  it('includes rows of every status and provenance', async () => {
    // Wider than createTopics' own per-fact floor on purpose: a tracked
    // collision would make a followed story billable again, and a retired
    // collision would re-append what the user just retired.
    seed([
      makeRecord({ id: 'a', normalizedText: 'active llm', status: 'active' }),
      makeRecord({ id: 'b', normalizedText: 'retired thing', status: 'retired' }),
      makeRecord({ id: 'c', normalizedText: 'tracked story', status: 'active' }),
    ]);

    const out = await getAllNormalizedTexts();

    expect(out).toEqual(new Set(['active llm', 'retired thing', 'tracked story']));
  });

  it('is empty for an empty table', async () => {
    seed([]);
    expect(await getAllNormalizedTexts()).toEqual(new Set());
  });
});

describe('appendTopupTopicsForFact', () => {
  beforeEach(() => {
    (db.batch as jest.Mock).mockClear();
    (db.write as jest.Mock).mockClear();
    seed([]);
  });

  it('mints at the reduced top-up weight, not the full llm seed weight', async () => {
    const out = await appendTopupTopicsForFact('f1', [
      { text: 'Bengaluru cricket news', normalizedText: 'bengaluru cricket news' },
    ]);

    // 0.5 requests ~30 articles per sync where 0.75 would request 40.
    expect(out[0].weight).toBe(0.5);
  });

  it("mints as 'llm' provenance, never 'tracked'", async () => {
    // 'tracked' would grant quota-exempt hydration for articles the user never
    // followed — a billing bug, not a labelling nicety.
    const out = await appendTopupTopicsForFact('f1', [
      { text: 'Bengaluru cricket news', normalizedText: 'bengaluru cricket news' },
    ]);

    expect(out[0].provenance).toBe('llm');
    expect(out[0].factId).toBe('f1');
    expect(out[0].status).toBe('active');
    expect(out[0].highPriority).toBe(false);
  });

  it('is a no-op for an empty plan', async () => {
    expect(await appendTopupTopicsForFact('f1', [])).toEqual([]);
    expect(db.write).not.toHaveBeenCalled();
  });

  it('still passes through the createTopics dedupe floor', async () => {
    seed([
      makeRecord({
        id: 'existing',
        normalizedText: 'bengaluru cricket news',
        factId: 'f1',
        status: 'active',
      }),
    ]);

    const out = await appendTopupTopicsForFact('f1', [
      { text: 'Bengaluru cricket news', normalizedText: 'bengaluru cricket news' },
    ]);

    expect(out[0].id).toBe('existing');
    expect(db.batch).not.toHaveBeenCalled();
  });
});
