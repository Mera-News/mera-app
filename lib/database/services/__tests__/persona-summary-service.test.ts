// persona-summary-service unit tests — WatermelonDB I/O via makeDatabaseMock.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

jest.mock('../../../logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import {
  toRow,
  getAllSummaryStrings,
  countSummaryStrings,
  getLatestPersonaVersion,
  replaceAllSummaryStrings,
  deleteSummaryString,
} from '../persona-summary-service';

const db = database as any;

function makeStringRecord(overrides: Record<string, any> = {}) {
  return makeRecord({
    id: overrides.id ?? 'str-1',
    text: overrides.text ?? 'Lives in Pune',
    linkedFactIdsJson: overrides.linkedFactIdsJson ?? '["fact-1"]',
    linkedTopicIdsJson: overrides.linkedTopicIdsJson ?? '["t1","t2"]',
    generatedAt: overrides.generatedAt ?? new Date(1700000000000),
    personaVersion: overrides.personaVersion ?? 'v1:2:abc',
    stale: overrides.stale ?? false,
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('persona_summary_strings', []);
});

describe('toRow', () => {
  it('parses the JSON id columns and normalizes fields', () => {
    const row = toRow(makeStringRecord() as any);
    expect(row).toEqual({
      id: 'str-1',
      text: 'Lives in Pune',
      linkedFactIds: ['fact-1'],
      linkedTopicIds: ['t1', 't2'],
      generatedAt: 1700000000000,
      personaVersion: 'v1:2:abc',
      stale: false,
    });
  });

  it('is resilient to malformed / missing JSON columns', () => {
    const row = toRow(makeStringRecord({ linkedFactIdsJson: 'not json', linkedTopicIdsJson: null }) as any);
    expect(row.linkedFactIds).toEqual([]);
    expect(row.linkedTopicIds).toEqual([]);
  });
});

describe('getAllSummaryStrings / countSummaryStrings', () => {
  it('maps every backing row through toRow', async () => {
    db._setRows('persona_summary_strings', [
      makeStringRecord({ id: 's1' }),
      makeStringRecord({ id: 's2', text: 'Follows cricket', linkedFactIdsJson: '["fact-2"]' }),
    ]);
    const rows = await getAllSummaryStrings();
    expect(rows.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(await countSummaryStrings()).toBe(2);
  });
});

describe('getLatestPersonaVersion', () => {
  it('returns the first row personaVersion (query sorted desc)', async () => {
    db._setRows('persona_summary_strings', [makeStringRecord({ personaVersion: 'v1:9:zzz' })]);
    expect(await getLatestPersonaVersion()).toBe('v1:9:zzz');
  });

  it('returns null when there are no strings', async () => {
    expect(await getLatestPersonaVersion()).toBeNull();
  });
});

describe('replaceAllSummaryStrings', () => {
  it('destroys existing rows and creates the new set with the persona version', async () => {
    const existing = makeStringRecord({ id: 'old-1' });
    db._setRows('persona_summary_strings', [existing]);
    const col = db._collections['persona_summary_strings'];

    await replaceAllSummaryStrings(
      [
        { text: 'Lives in Pune', linkedFactIds: ['fact-1'], linkedTopicIds: ['t1'] },
        { text: 'Follows startups', linkedFactIds: ['fact-2'], linkedTopicIds: ['t2', 't3'] },
      ],
      'v1:2:def',
    );

    expect(existing.prepareDestroyPermanently).toHaveBeenCalled();
    expect(col.prepareCreate).toHaveBeenCalledTimes(2);
    expect(db.batch).toHaveBeenCalled();
    // Assert one created record carried the expected serialized fields.
    const ops = db.batch.mock.calls[0];
    const created = ops.flat().filter((r: any) => r.text === 'Follows startups');
    expect(created).toHaveLength(1);
    expect(created[0].linkedTopicIdsJson).toBe('["t2","t3"]');
    expect(created[0].personaVersion).toBe('v1:2:def');
    expect(created[0].stale).toBe(false);
  });

  it('clears all rows when given an empty result set', async () => {
    const existing = makeStringRecord({ id: 'old-1' });
    db._setRows('persona_summary_strings', [existing]);
    const col = db._collections['persona_summary_strings'];

    await replaceAllSummaryStrings([], null);

    expect(existing.prepareDestroyPermanently).toHaveBeenCalled();
    expect(col.prepareCreate).not.toHaveBeenCalled();
  });
});

describe('deleteSummaryString', () => {
  it('destroys the target and marks the rest stale', async () => {
    const target = makeStringRecord({ id: 'del-me' });
    const other = makeStringRecord({ id: 'keep', stale: false });
    db._setRows('persona_summary_strings', [target, other]);

    await deleteSummaryString('del-me');

    expect(target.prepareDestroyPermanently).toHaveBeenCalled();
    // `other` is marked stale via prepareUpdate (fake returns all rows for the query).
    expect(other.prepareUpdate).toHaveBeenCalled();
    expect(other.stale).toBe(true);
  });

  it('swallows a missing-record error (never throws)', async () => {
    db._setRows('persona_summary_strings', []);
    await expect(deleteSummaryString('nope')).resolves.toBeUndefined();
  });
});
