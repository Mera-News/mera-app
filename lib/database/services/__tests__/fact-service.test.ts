// fact-service unit tests
// WatermelonDB I/O intercepted via makeDatabaseMock().
// setting-service is mocked so questionnaire level tests stay pure.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

const mockGetSetting = jest.fn((_key: string): Promise<string | null> => Promise.resolve(null));
const mockSetSetting = jest.fn((_key: string, _value: string): Promise<void> => Promise.resolve());

jest.mock('../setting-service', () => ({
  getSetting: (key: string) => mockGetSetting(key),
  setSetting: (key: string, value: string) => mockSetSetting(key, value),
}));

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import {
  addFact,
  updateFact,
  deleteFact,
  getFacts,
  getFactsForTopicTexts,
  getCoveredAttributeKeys,
  getQuestionnaireLevel,
  setQuestionnaireLevel,
  markOrphanedFactsAsFailed,
} from '../fact-service';

const db = database as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2024-01-01T00:00:00.000Z');

function makeFactRecord(overrides: Record<string, any> = {}) {
  return makeRecord({
    id: overrides.id ?? 'fact-1',
    statement: overrides.statement ?? 'I live in Berlin',
    metadata: overrides.metadata ?? { topics: ['berlin', 'germany'] },
    questionnaireLevel: overrides.questionnaireLevel ?? null,
    questionnaireLevelCategory: overrides.questionnaireLevelCategory ?? null,
    questionnaireAttribute: overrides.questionnaireAttribute ?? null,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    updateFact: jest.fn(async () => {}),
    destroyCascade: jest.fn(async () => {}),
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('facts', []);
});

// ---------------------------------------------------------------------------
// addFact
// ---------------------------------------------------------------------------

describe('addFact', () => {
  it('creates a fact with statement only', async () => {
    const col = db._collections['facts'];
    // Arrange: make sure created records have required date fields
    col.create = jest.fn(async (fn: (r: any) => void) => {
      const rec = makeFactRecord({ id: 'new-1', statement: '' });
      fn(rec);
      return rec;
    });
    const result = await addFact('I am a developer');
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(col.create).toHaveBeenCalledTimes(1);
    expect(result.statement).toBe('I am a developer');
  });

  it('sets metadata when provided', async () => {
    const col = db._collections['facts'];
    col.create = jest.fn(async (fn: (r: any) => void) => {
      const rec = makeFactRecord({ id: 'new-2', statement: '' });
      fn(rec);
      return rec;
    });
    const meta = { topics: ['coding'] };
    const result = await addFact('I code daily', meta);
    expect(result.metadata).toEqual(meta);
  });

  it('sets questionnaire fields when provided', async () => {
    const col = db._collections['facts'];
    col.create = jest.fn(async (fn: (r: any) => void) => {
      const rec = makeFactRecord({ id: 'new-3', statement: '' });
      fn(rec);
      return rec;
    });
    const result = await addFact('I live in Berlin', undefined, {
      level: 2,
      levelCategory: 'Core',
      attribute: 'location: neighborhood',
    });
    expect(result.questionnaireLevel).toBe(2);
    expect(result.questionnaireLevelCategory).toBe('Core');
    expect(result.questionnaireAttribute).toBe('location: neighborhood');
  });

  it('does not set questionnaire fields when questionnaire is not provided', async () => {
    const col = db._collections['facts'];
    col.create = jest.fn(async (fn: (r: any) => void) => {
      const rec = makeFactRecord({ id: 'new-4', statement: '', questionnaireLevel: null });
      fn(rec);
      return rec;
    });
    const result = await addFact('No questionnaire');
    // toFact converts null → undefined via `?? undefined`
    expect(result.questionnaireLevel).toBeUndefined();
  });

  it('returns a Fact with ISO createdAt/updatedAt strings', async () => {
    const col = db._collections['facts'];
    col.create = jest.fn(async (fn: (r: any) => void) => {
      const rec = makeFactRecord({ id: 'new-5' });
      fn(rec);
      return rec;
    });
    const result = await addFact('Check dates');
    expect(typeof result.createdAt).toBe('string');
    expect(typeof result.updatedAt).toBe('string');
    expect(result.createdAt).toBe(NOW.toISOString());
  });
});

// ---------------------------------------------------------------------------
// updateFact
// ---------------------------------------------------------------------------

describe('updateFact', () => {
  it('calls updateFact on the found record with new statement', async () => {
    const rec = makeFactRecord({ id: 'f1', statement: 'old' });
    db._setRows('facts', [rec]);
    await updateFact('f1', { statement: 'new statement' });
    expect(rec.updateFact).toHaveBeenCalledWith('new statement', rec.metadata);
  });

  it('keeps the existing statement when only metadata is updated', async () => {
    const rec = makeFactRecord({ id: 'f1', statement: 'keep me' });
    db._setRows('facts', [rec]);
    const newMeta = { topics: ['updated'] };
    await updateFact('f1', { metadata: newMeta });
    expect(rec.updateFact).toHaveBeenCalledWith('keep me', newMeta);
  });

  it('passes existing metadata when metadata is not in updates', async () => {
    const rec = makeFactRecord({ id: 'f1', metadata: { topics: ['original'] } });
    db._setRows('facts', [rec]);
    await updateFact('f1', { statement: 'changed' });
    expect(rec.updateFact).toHaveBeenCalledWith('changed', rec.metadata);
  });

  it('passes undefined for metadata when explicitly updated to undefined', async () => {
    const rec = makeFactRecord({ id: 'f1', metadata: { topics: ['x'] } });
    db._setRows('facts', [rec]);
    // updates.metadata is undefined (the key exists but value is undefined)
    // In JS, `{ metadata: undefined }` sets the key — service passes rec.metadata
    // because `updates.metadata !== undefined` is false
    // Correct behavior: undefined means "keep existing"
    await updateFact('f1', { metadata: undefined });
    expect(rec.updateFact).toHaveBeenCalledWith(rec.statement, rec.metadata);
  });

  it('returns the updated Fact', async () => {
    const rec = makeFactRecord({ id: 'f1', statement: 'original' });
    rec.updateFact = jest.fn(async () => { rec.statement = 'updated'; });
    db._setRows('facts', [rec]);
    const result = await updateFact('f1', { statement: 'updated' });
    expect(result.id).toBe('f1');
    expect(result.statement).toBe('updated');
  });

  it('throws when the record is not found', async () => {
    db._setRows('facts', []);
    await expect(updateFact('nonexistent', { statement: 'x' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// deleteFact
// ---------------------------------------------------------------------------

describe('deleteFact', () => {
  it('calls destroyCascade on the found record', async () => {
    const rec = makeFactRecord({ id: 'f1' });
    db._setRows('facts', [rec]);
    await deleteFact('f1');
    expect(rec.destroyCascade).toHaveBeenCalledTimes(1);
  });

  it('throws when the record is not found', async () => {
    db._setRows('facts', []);
    await expect(deleteFact('ghost')).rejects.toThrow('record not found');
  });
});

// ---------------------------------------------------------------------------
// getFacts
// ---------------------------------------------------------------------------

describe('getFacts', () => {
  it('returns an empty array when no facts exist', async () => {
    db._setRows('facts', []);
    const result = await getFacts();
    expect(result).toEqual([]);
  });

  it('maps all records to Fact objects', async () => {
    db._setRows('facts', [
      makeFactRecord({ id: 'f1', statement: 'fact one' }),
      makeFactRecord({ id: 'f2', statement: 'fact two' }),
    ]);
    const result = await getFacts();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('f1');
    expect(result[1].id).toBe('f2');
  });

  it('includes optional questionnaire fields when set', async () => {
    db._setRows('facts', [
      makeFactRecord({
        id: 'f1',
        questionnaireLevel: 3,
        questionnaireLevelCategory: 'Professional',
        questionnaireAttribute: 'job: developer',
      }),
    ]);
    const [fact] = await getFacts();
    expect(fact.questionnaireLevel).toBe(3);
    expect(fact.questionnaireLevelCategory).toBe('Professional');
    expect(fact.questionnaireAttribute).toBe('job: developer');
  });

  it('returns undefined for optional questionnaire fields when not set', async () => {
    db._setRows('facts', [makeFactRecord({ id: 'f1', questionnaireLevel: null })]);
    const [fact] = await getFacts();
    expect(fact.questionnaireLevel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getFactsForTopicTexts
// ---------------------------------------------------------------------------

describe('getFactsForTopicTexts', () => {
  it('returns empty array when topicTexts is empty', async () => {
    const result = await getFactsForTopicTexts([]);
    expect(result).toEqual([]);
    // Should not even query the DB
    expect(db._collections['facts']?.query).not.toHaveBeenCalled();
  });

  it('returns facts whose metadata.topics overlaps the given texts', async () => {
    db._setRows('facts', [
      makeFactRecord({ id: 'f1', metadata: { topics: ['berlin', 'germany'] } }),
      makeFactRecord({ id: 'f2', metadata: { topics: ['paris', 'france'] } }),
      makeFactRecord({ id: 'f3', metadata: { topics: ['berlin'] } }),
    ]);
    const result = await getFactsForTopicTexts(['berlin']);
    const ids = result.map((f) => f.id);
    expect(ids).toContain('f1');
    expect(ids).toContain('f3');
    expect(ids).not.toContain('f2');
  });

  it('returns empty array when no facts match', async () => {
    db._setRows('facts', [
      makeFactRecord({ id: 'f1', metadata: { topics: ['london'] } }),
    ]);
    const result = await getFactsForTopicTexts(['tokyo']);
    expect(result).toEqual([]);
  });

  it('handles facts with missing metadata gracefully', async () => {
    db._setRows('facts', [
      makeFactRecord({ id: 'f1', metadata: undefined }),
      makeFactRecord({ id: 'f2', metadata: { topics: ['coding'] } }),
    ]);
    const result = await getFactsForTopicTexts(['coding']);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('f2');
  });

  it('handles facts with missing topics array gracefully', async () => {
    db._setRows('facts', [
      makeFactRecord({ id: 'f1', metadata: {} }),
    ]);
    const result = await getFactsForTopicTexts(['coding']);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getCoveredAttributeKeys
// ---------------------------------------------------------------------------

describe('getCoveredAttributeKeys', () => {
  it('returns an empty set when no records have questionnaire_attribute', async () => {
    db._setRows('facts', []);
    const keys = await getCoveredAttributeKeys();
    expect(keys.size).toBe(0);
  });

  it('extracts the key before the colon', async () => {
    db._setRows('facts', [
      makeFactRecord({
        id: 'f1',
        questionnaireAttribute: 'location: neighborhood/area, city, and country',
      }),
    ]);
    const keys = await getCoveredAttributeKeys();
    expect(keys.has('location')).toBe(true);
  });

  it('uses the full string as key when there is no colon', async () => {
    db._setRows('facts', [
      makeFactRecord({ id: 'f1', questionnaireAttribute: 'profession' }),
    ]);
    const keys = await getCoveredAttributeKeys();
    expect(keys.has('profession')).toBe(true);
  });

  it('deduplicates keys across multiple records', async () => {
    db._setRows('facts', [
      makeFactRecord({ id: 'f1', questionnaireAttribute: 'location: city' }),
      makeFactRecord({ id: 'f2', questionnaireAttribute: 'location: country' }),
    ]);
    const keys = await getCoveredAttributeKeys();
    expect(keys.size).toBe(1);
    expect(keys.has('location')).toBe(true);
  });

  it('skips records with null questionnaireAttribute', async () => {
    db._setRows('facts', [
      makeFactRecord({ id: 'f1', questionnaireAttribute: null }),
    ]);
    const keys = await getCoveredAttributeKeys();
    expect(keys.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getQuestionnaireLevel
// ---------------------------------------------------------------------------

describe('getQuestionnaireLevel', () => {
  it('returns 1 as default when no setting exists', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    const level = await getQuestionnaireLevel();
    expect(level).toBe(1);
    expect(mockGetSetting).toHaveBeenCalledWith('questionnaire_level');
  });

  it('returns the persisted level when it exists', async () => {
    mockGetSetting.mockResolvedValueOnce('5');
    const level = await getQuestionnaireLevel();
    expect(level).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// setQuestionnaireLevel
// ---------------------------------------------------------------------------

describe('setQuestionnaireLevel', () => {
  it('persists the level via setSetting', async () => {
    await setQuestionnaireLevel(3);
    expect(mockSetSetting).toHaveBeenCalledWith('questionnaire_level', '3');
  });

  it('clamps the level to minimum 1', async () => {
    await setQuestionnaireLevel(0);
    expect(mockSetSetting).toHaveBeenCalledWith('questionnaire_level', '1');
  });

  it('clamps the level to maximum 10', async () => {
    await setQuestionnaireLevel(99);
    expect(mockSetSetting).toHaveBeenCalledWith('questionnaire_level', '10');
  });

  it('allows the boundary value 1', async () => {
    await setQuestionnaireLevel(1);
    expect(mockSetSetting).toHaveBeenCalledWith('questionnaire_level', '1');
  });

  it('allows the boundary value 10', async () => {
    await setQuestionnaireLevel(10);
    expect(mockSetSetting).toHaveBeenCalledWith('questionnaire_level', '10');
  });
});

// ---------------------------------------------------------------------------
// markOrphanedFactsAsFailed
// ---------------------------------------------------------------------------

describe('markOrphanedFactsAsFailed', () => {
  it('returns 0 when no records exist', async () => {
    db._setRows('facts', []);
    const count = await markOrphanedFactsAsFailed(new Set(), 'timed out');
    expect(count).toBe(0);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('skips records that are in the activeFactIds set', async () => {
    const rec = makeFactRecord({ id: 'active-1', metadata: undefined });
    db._setRows('facts', [rec]);
    const count = await markOrphanedFactsAsFailed(new Set(['active-1']), 'err');
    expect(count).toBe(0);
    expect(database.write).not.toHaveBeenCalled();
  });

  it('skips records that already have topics', async () => {
    const rec = makeFactRecord({ id: 'f1', metadata: { topics: ['berlin'] } });
    db._setRows('facts', [rec]);
    const count = await markOrphanedFactsAsFailed(new Set(), 'err');
    expect(count).toBe(0);
  });

  it('skips records that already have a topicGenError', async () => {
    const rec = makeFactRecord({
      id: 'f1',
      metadata: { topicGenError: ['previous error'] },
    });
    db._setRows('facts', [rec]);
    const count = await markOrphanedFactsAsFailed(new Set(), 'err');
    expect(count).toBe(0);
  });

  it('marks orphaned facts (no topics, no error, not active) as failed', async () => {
    const rec = makeFactRecord({ id: 'f1', metadata: {} });
    db._setRows('facts', [rec]);
    const count = await markOrphanedFactsAsFailed(new Set(), 'timed out');
    expect(count).toBe(1);
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(database.batch).toHaveBeenCalledTimes(1);
    // The prepareUpdate mutates rec.metadata to include topicGenError
    expect(rec.metadata).toMatchObject({ topicGenError: ['timed out'] });
  });

  it('marks multiple orphaned facts in a single batch write', async () => {
    const r1 = makeFactRecord({ id: 'f1', metadata: {} });
    const r2 = makeFactRecord({ id: 'f2', metadata: {} });
    db._setRows('facts', [r1, r2]);
    const count = await markOrphanedFactsAsFailed(new Set(), 'err');
    expect(count).toBe(2);
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(database.batch).toHaveBeenCalledTimes(1);
    const batchArgs = (database.batch as jest.Mock).mock.calls[0][0];
    expect(batchArgs).toHaveLength(2);
  });

  it('handles records with null metadata (treats as having no topics)', async () => {
    const rec = makeFactRecord({ id: 'f1', metadata: null });
    db._setRows('facts', [rec]);
    const count = await markOrphanedFactsAsFailed(new Set(), 'err');
    expect(count).toBe(1);
  });

  it('merges errorMessage into existing metadata fields', async () => {
    const rec = makeFactRecord({ id: 'f1', metadata: { someOtherKey: ['val'] } });
    db._setRows('facts', [rec]);
    await markOrphanedFactsAsFailed(new Set(), 'custom error');
    expect(rec.metadata).toMatchObject({
      someOtherKey: ['val'],
      topicGenError: ['custom error'],
    });
  });
});
