// persona-summary-service at its seam: the "About you" strings the Profile tab shows, over the
// in-memory DB. Replaces lib/database/services/__tests__/persona-summary-service.test.ts, whose
// mock returned every row for every query: "marks the rest stale" and "returns the latest version"
// held because the fake ignored the id and sort clauses. Here deleteSummaryString's
// Q.where('id', Q.notEq(id)) and getLatestPersonaVersion's desc sort run against real rows.
//
// persona-summary-trigger.ts has no test, legacy or here: maybeRegeneratePersonaSummary has no
// caller, so it is reported as uncovered dead code.
//
// Unreachable at any seam (R30 candidate): the `Number(m.generatedAt ?? 0)` arm of toRow, line 44.
// The model's @date getter always returns a Date, and a lost timestamp is Date(0).
//
// Not carried over: "calls database.batch / prepareCreate N times" (mock-call counts; the rows
// left behind are asserted instead).
import {
  countSummaryStrings,
  deleteSummaryString,
  getAllSummaryStrings,
  getLatestPersonaVersion,
  markAllStale,
  observeSummaryStrings,
  replaceAllSummaryStrings,
  toRow,
} from '@/lib/database/services/persona-summary-service';
import database from '@/lib/database';
import { corruptColumn, countRows, countWrites, freezeClock, quietLogger, restoreFaults, rowById, T0 } from './support';

beforeEach(() => freezeClock());
afterEach(restoreFaults);

const tick = (ms = 1000) => jest.advanceTimersByTime(ms);
const res = (text: string, facts: string[] = [], topics: string[] = []) => ({ text, linkedFactIds: facts, linkedTopicIds: topics });
const all = async () => (await database.get('persona_summary_strings').query().fetch()) as any[];
const byText = async (text: string) => (await all()).find((r) => r.text === text);

describe('replaceAllSummaryStrings', () => {
  it('writes the set with serialized links, the persona version, now, and not stale', async () => {
    await replaceAllSummaryStrings(
      [res('Lives in Pune', ['fact-1'], ['t1']), res('Follows startups', ['fact-2'], ['t2', 't3'])],
      'v1:2:def',
    );

    expect(await all()).toHaveLength(2);
    const row = await byText('Follows startups');
    expect(row).toMatchObject({
      linkedFactIdsJson: '["fact-2"]',
      linkedTopicIdsJson: '["t2","t3"]',
      personaVersion: 'v1:2:def',
      stale: false,
    });
    expect(row.generatedAt.getTime()).toBe(T0);
  });

  it('replaces the old set in ONE write: the old rows are gone and there is no empty state', async () => {
    await replaceAllSummaryStrings([res('old 1'), res('old 2')], 'v1');
    const writes = countWrites();

    await replaceAllSummaryStrings([res('new 1')], 'v2');

    expect(writes).toHaveBeenCalledTimes(1);
    expect((await all()).map((r) => r.text)).toEqual(['new 1']);
  });

  it('clears every row when given an empty set', async () => {
    await replaceAllSummaryStrings([res('old')], 'v1');
    await replaceAllSummaryStrings([], null);
    expect(await countRows('persona_summary_strings')).toBe(0);
  });

  it('stores a null persona version', async () => {
    await replaceAllSummaryStrings([res('x')], null);
    expect((await byText('x')).personaVersion).toBeNull();
  });
});

describe('countSummaryStrings', () => {
  it('counts the rows', async () => {
    expect(await countSummaryStrings()).toBe(0);
    await replaceAllSummaryStrings([res('a'), res('b'), res('c')], 'v1');
    expect(await countSummaryStrings()).toBe(3);
  });
});

describe('getLatestPersonaVersion', () => {
  it('is null when there are no strings', async () => {
    expect(await getLatestPersonaVersion()).toBeNull();
  });

  it('is the version of the newest generation', async () => {
    await replaceAllSummaryStrings([res('a')], 'v1:9:zzz');
    expect(await getLatestPersonaVersion()).toBe('v1:9:zzz');

    tick();
    await replaceAllSummaryStrings([res('b')], 'v1:10:aaa');
    expect(await getLatestPersonaVersion()).toBe('v1:10:aaa');
  });

  it('is null when the newest set was stamped without a version', async () => {
    await replaceAllSummaryStrings([res('a')], null);
    expect(await getLatestPersonaVersion()).toBeNull();
  });
});

describe('observeSummaryStrings', () => {
  it('emits the current rows, then again on a replace and on a delete', async () => {
    await replaceAllSummaryStrings([res('a'), res('b')], 'v1');
    const seen: string[][] = [];
    const sub = observeSummaryStrings().subscribe((rows) => seen.push(rows.map((r) => r.text).sort()));
    await jest.advanceTimersByTimeAsync(0);

    tick();
    await replaceAllSummaryStrings([res('c')], 'v2');
    await jest.advanceTimersByTimeAsync(0);
    await deleteSummaryString((await byText('c')).id);
    await jest.advanceTimersByTimeAsync(0);
    sub.unsubscribe();

    expect(seen[0]).toEqual(['a', 'b']);
    expect(seen.at(-1)).toEqual([]);
    expect(seen).toContainEqual(['c']);
  });
});

describe('toRow', () => {
  it('reads the stored columns as the UI row', async () => {
    await replaceAllSummaryStrings([res('Lives in Pune', ['fact-1'], ['t1', 't2'])], 'v1:2:abc');
    const row = await byText('Lives in Pune');

    expect(toRow(row)).toEqual({
      id: row.id,
      text: 'Lives in Pune',
      linkedFactIds: ['fact-1'],
      linkedTopicIds: ['t1', 't2'],
      generatedAt: T0,
      personaVersion: 'v1:2:abc',
      stale: false,
    });
  });

  it('reads malformed or non-array link columns as empty lists and drops non-string ids', async () => {
    await replaceAllSummaryStrings([res('x', ['f'], ['t'])], 'v1');
    const id = (await byText('x')).id;

    await corruptColumn('persona_summary_strings', id, 'linkedFactIdsJson', 'not json');
    await corruptColumn('persona_summary_strings', id, 'linkedTopicIdsJson', '["t",7,null]');
    expect(toRow((await rowById('persona_summary_strings', id))!)).toMatchObject({ linkedFactIds: [], linkedTopicIds: ['t'] });

    await corruptColumn('persona_summary_strings', id, 'linkedFactIdsJson', '{"a":1}');
    await corruptColumn('persona_summary_strings', id, 'linkedTopicIdsJson', '');
    expect(toRow((await rowById('persona_summary_strings', id))!)).toMatchObject({ linkedFactIds: [], linkedTopicIds: [] });
  });

  it('reads a null persona version as null, a null stale flag as not stale and a lost timestamp as 0', async () => {
    await replaceAllSummaryStrings([res('x')], null);
    const id = (await byText('x')).id;
    await corruptColumn('persona_summary_strings', id, 'stale', null);
    await corruptColumn('persona_summary_strings', id, 'generatedAt', null);

    expect(toRow((await rowById('persona_summary_strings', id))!)).toMatchObject({ personaVersion: null, stale: false, generatedAt: 0 });
  });
});

describe('deleteSummaryString', () => {
  it('destroys that string and marks every other one stale', async () => {
    await replaceAllSummaryStrings([res('del-me'), res('keep 1'), res('keep 2')], 'v1');
    const target = (await byText('del-me')).id;

    await deleteSummaryString(target);

    expect(await rowById('persona_summary_strings', target)).toBeNull();
    const left = await all();
    expect(left.map((r) => r.text).sort()).toEqual(['keep 1', 'keep 2']);
    expect(left.map((r) => r.stale)).toEqual([true, true]);
  });

  it('swallows a missing id: nothing is deleted, nothing is marked stale, a warning is logged', async () => {
    const logs = quietLogger();
    await replaceAllSummaryStrings([res('keep')], 'v1');

    await expect(deleteSummaryString('nope')).resolves.toBeUndefined();

    expect((await all()).map((r) => [r.text, r.stale])).toEqual([['keep', false]]);
    expect(logs.warn).toHaveBeenCalledWith('[persona-summary] deleteSummaryString failed', expect.objectContaining({ id: 'nope' }));
  });

  it('deleting the only string leaves nothing and does not fail', async () => {
    await replaceAllSummaryStrings([res('only')], 'v1');
    await deleteSummaryString((await byText('only')).id);
    expect(await countRows('persona_summary_strings')).toBe(0);
  });
});

// [dead-candidate] getAllSummaryStrings and markAllStale have no callers outside tests.
describe('[dead-candidate] getAllSummaryStrings', () => {
  it('maps every row through toRow', async () => {
    await replaceAllSummaryStrings([res('a', ['f1']), res('b', ['f2'])], 'v1');

    const rows = await getAllSummaryStrings();
    expect(rows.map((r) => r.text).sort()).toEqual(['a', 'b']);
    expect(rows.find((r) => r.text === 'b')?.linkedFactIds).toEqual(['f2']);
  });

  it('is empty for an empty table', async () => {
    expect(await getAllSummaryStrings()).toEqual([]);
  });
});

describe('[dead-candidate] markAllStale', () => {
  it('marks every string that is not already stale', async () => {
    await replaceAllSummaryStrings([res('a'), res('b')], 'v1');
    await markAllStale();
    expect((await all()).map((r) => r.stale)).toEqual([true, true]);
  });

  it('is a no-op on an empty table and on strings that are already stale', async () => {
    await expect(markAllStale()).resolves.toBeUndefined();
    await replaceAllSummaryStrings([res('a')], 'v1');
    await markAllStale();
    await markAllStale();

    expect((await all()).map((r) => r.stale)).toEqual([true]);
  });
});
