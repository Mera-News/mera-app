// r12 K-P5 — the three atomicity properties of replaceTopicsForFact.
//
// These rows are derived from the user's own facts and no server can rebuild
// them, so this is the one genuinely irreversible operation in the wave:
//   (a) generation runs first — any failure changes NOTHING (covered in
//       topic-replacement-service.test.ts, which owns the network seam);
//   (b) the mint and the retires land in ONE database.write/batch;
//   (c) the floor: never leave a fact with zero active topics.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import { replaceTopicsForFact } from '../topic-service';

const db = database as any;

function row(id: string, status: 'active' | 'retired' = 'active') {
  return makeRecord({
    id,
    factId: 'f1',
    text: id,
    normalizedText: id,
    status,
    weight: 0.75,
  });
}

const plan = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    text: `replacement ${i}`,
    normalizedText: `replacement ${i}`,
  }));

describe('(b) mint and retire land in a SINGLE write', () => {
  beforeEach(() => {
    (db.batch as jest.Mock).mockClear();
    (db.write as jest.Mock).mockClear();
  });

  it('issues exactly one write and one batch containing BOTH operations', async () => {
    db._setRows('topics', [row('good'), row('bad1'), row('bad2')]);

    const res = await replaceTopicsForFact('f1', plan(2), ['bad1', 'bad2']);

    // One write, one batch — a kill mid-write yields both or neither.
    expect(db.write).toHaveBeenCalledTimes(1);
    expect(db.batch).toHaveBeenCalledTimes(1);

    const batched = (db.batch as jest.Mock).mock.calls[0][0];
    expect(batched).toHaveLength(4); // 2 creates + 2 retires
    expect(res.minted).toHaveLength(2);
    expect(res.retired).toEqual(['bad1', 'bad2']);
  });

  it('flips the retired rows to status retired inside that same batch', async () => {
    const bad = row('bad1');
    db._setRows('topics', [row('good'), bad]);

    await replaceTopicsForFact('f1', plan(1), ['bad1']);

    expect(bad.status).toBe('retired');
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it('mints replacements as llm at the reduced top-up weight', async () => {
    db._setRows('topics', [row('good'), row('bad1')]);

    const res = await replaceTopicsForFact('f1', plan(1), ['bad1']);

    expect(res.minted[0].provenance).toBe('llm');
    expect(res.minted[0].weight).toBe(0.5);
    expect(res.minted[0].factId).toBe('f1');
  });

  it('writes nothing at all when there is neither a mint nor a retire', async () => {
    db._setRows('topics', [row('good')]);

    const res = await replaceTopicsForFact('f1', [], []);

    expect(db.write).not.toHaveBeenCalled();
    expect(res).toEqual({ minted: [], retired: [], floorHeld: false });
  });
});

describe('(c) the floor — a fact never goes dark', () => {
  beforeEach(() => {
    (db.batch as jest.Mock).mockClear();
    (db.write as jest.Mock).mockClear();
  });

  it('WITHHOLDS the retire when zero replacements came back and all are bad', async () => {
    // Every active topic judged incoherent, generation produced nothing usable.
    // Retiring would leave the fact with no active topics at all — it would stop
    // producing feed content entirely. Keeping a mediocre topic is lesser harm.
    const bad = row('bad1');
    db._setRows('topics', [bad]);

    const res = await replaceTopicsForFact('f1', [], ['bad1']);

    expect(res.floorHeld).toBe(true);
    expect(res.retired).toEqual([]);
    expect(bad.status).toBe('active');
    expect(db.write).not.toHaveBeenCalled();
  });

  it('ALLOWS the retire when replacements cover the loss', async () => {
    db._setRows('topics', [row('bad1')]);

    const res = await replaceTopicsForFact('f1', plan(1), ['bad1']);

    expect(res.floorHeld).toBe(false);
    expect(res.retired).toEqual(['bad1']);
  });

  it('ALLOWS the retire when another active topic survives', async () => {
    db._setRows('topics', [row('good'), row('bad1')]);

    const res = await replaceTopicsForFact('f1', [], ['bad1']);

    expect(res.floorHeld).toBe(false);
    expect(res.retired).toEqual(['bad1']);
  });

  it('still mints even while the retire is withheld', async () => {
    // The fact gets its replacements; only the removal is deferred.
    db._setRows('topics', [row('bad1')]);

    const res = await replaceTopicsForFact('f1', [], ['bad1']);

    expect(res.floorHeld).toBe(true);
    expect(res.minted).toEqual([]);
  });

  it('counts only ACTIVE rows toward the floor', async () => {
    // Two retired siblings must not make it look safe to empty the fact.
    const bad = row('bad1');
    db._setRows('topics', [bad, row('old1', 'retired'), row('old2', 'retired')]);

    const res = await replaceTopicsForFact('f1', [], ['bad1']);

    expect(res.floorHeld).toBe(true);
    expect(bad.status).toBe('active');
  });
});

describe('retire targeting', () => {
  beforeEach(() => {
    (db.batch as jest.Mock).mockClear();
    (db.write as jest.Mock).mockClear();
  });

  it('ignores ids that are not active (already retired)', async () => {
    db._setRows('topics', [row('good'), row('already', 'retired')]);

    const res = await replaceTopicsForFact('f1', plan(1), ['already']);

    expect(res.retired).toEqual([]);
    expect(res.minted).toHaveLength(1);
  });

  it('ignores ids that do not belong to the fact', async () => {
    db._setRows('topics', [row('good'), row('bad1')]);

    const res = await replaceTopicsForFact('f1', plan(1), ['someone-elses-topic']);

    expect(res.retired).toEqual([]);
  });
});
