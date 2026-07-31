// retire_suppression apply + revert round-trip (P3, D5).
//
// Mirrors persona-action-executor-pubpref-revert.test.ts: the REAL executor,
// persona-change-log-service and suppression-service are wired to the fake
// WatermelonDB, so the full loop — add a filter, remove it, undo the removal —
// is exercised end to end. That proves the new invert-map branch actually
// restores the row, which a mocked dispatch test cannot.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(() => 'evt') },
}));

jest.mock('@/lib/services/suppression-sweep', () => ({
  purgeHardFilteredSuggestions: jest.fn(async () => ({
    excludedIds: [],
    valueById: new Map(),
    evictedFromFeed: 0,
  })),
  unexcludeRetiredHardFilters: jest.fn(async () => ({ resetIds: [], stillExcluded: 0 })),
}));

const mockSetFeedNeedsRefresh = jest.fn();
jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: { getState: () => ({ setFeedNeedsRefresh: mockSetFeedNeedsRefresh }) },
}));

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import { applyPersonaAction } from '../persona-action-executor';
import { revertChange } from '../persona-change-log-service';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import * as sweep from '@/lib/services/suppression-sweep';

const db = database as any;

/** Make a collection's create() assign incremental ids and persist the row. */
function withIds(table: string, prefix: string) {
  const col = db._collections[table];
  let n = 0;
  col.create = jest.fn(async (fn?: (r: any) => void) => {
    const rec = makeRecord({ id: `${prefix}-${++n}` });
    fn?.(rec);
    col._rows.push(rec);
    return rec;
  });
}

const supRows = () => db._collections['persona_suppressions']._rows as any[];
const logRows = () => db._collections['persona_change_log']._rows as any[];
const findLog = (id?: string) => logRows().find((r: any) => r.id === id);

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('persona_suppressions', []);
  db._setRows('persona_change_log', []);
  withIds('persona_suppressions', 'sup');
  withIds('persona_change_log', 'cl');
});

describe('add_suppression → retire_suppression → revert (hard, structured)', () => {
  it('round-trips a hard publication filter back to active', async () => {
    // 1. Add a HARD, structured filter.
    const added = await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'Daily Blether',
        suppressionKind: 'publication',
        suppressionValue: 'Daily Blether',
        suppressionStrength: 0.9,
      },
      'user',
    );
    expect(added.applied).toBe(true);

    const stored = supRows()[0];
    expect(stored.kind).toBe('publication');
    expect(stored.value).toBe('Daily Blether');
    expect(stored.status).toBe('active');
    // A user-created row reads as 'user', not the old hardcoded 'feedback'.
    expect(stored.source).toBe('user');
    // Hard ⇒ no expiry, and the stored feed is purged retroactively (D12a).
    expect(stored.expiresAt).toBeNull();
    expect(sweep.purgeHardFilteredSuggestions).toHaveBeenCalledTimes(1);

    // 2. Remove it — audited, and the un-exclude sweep runs (D12c).
    const retired = await applyPersonaAction(
      { action_type: ACTION_NAMES.RETIRE_SUPPRESSION, suppressionId: stored.id },
      'user',
    );
    expect(retired).toMatchObject({
      applied: true,
      summary: 'Removed filter: Daily Blether',
    });
    expect(stored.status).toBe('retired');
    expect(sweep.unexcludeRetiredHardFilters).toHaveBeenCalledTimes(1);

    const logRow = findLog(retired.changeLogId);
    expect(logRow.actionType).toBe(ACTION_NAMES.RETIRE_SUPPRESSION);
    expect(JSON.parse(logRow.actionJson)).toMatchObject({
      targetId: stored.id,
      pattern: 'Daily Blether',
      kind: 'publication',
    });

    // 3. Undo the removal — the filter comes back active, AND re-purges.
    await revertChange(retired.changeLogId!);
    expect(stored.status).toBe('active');
    expect(logRow.reverted).toBe(true);
    // …and a revert_change audit row was appended.
    expect(logRows().some((r: any) => r.actionType === 'revert_change')).toBe(true);
    // D12: the reinstated hard filter must screen the stored feed again —
    // the mirror of the un-exclude the removal performed.
    expect(sweep.purgeHardFilteredSuggestions).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// The D12c hole this phase closed: revert is a mutation path too.
// ---------------------------------------------------------------------------

describe('revert runs the MIRROR sweep (D12c)', () => {
  it('reverting a HARD add releases the rows the add had purged', async () => {
    const added = await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'cricket',
        suppressionStrength: 0.9,
      },
      'user',
    );
    expect(sweep.purgeHardFilteredSuggestions).toHaveBeenCalledTimes(1);
    expect(sweep.unexcludeRetiredHardFilters).not.toHaveBeenCalled();

    // Undo from the Activity screen. Before this phase NOTHING ran here, so
    // the purged articles stayed excluded for the rest of the 48h window.
    await revertChange(added.changeLogId!);

    expect(supRows()[0].status).toBe('retired');
    expect(sweep.unexcludeRetiredHardFilters).toHaveBeenCalledTimes(1);
    // The un-exclude is what resets the previously-excluded rows to `unscored`.
    expect(sweep.purgeHardFilteredSuggestions).toHaveBeenCalledTimes(1);
  });

  it('reverting a SOFT add runs no sweep (it never excluded anything)', async () => {
    const added = await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'gossip',
        suppressionStrength: 0.5,
      },
      'user',
    );
    await revertChange(added.changeLogId!);

    expect(supRows()[0].status).toBe('retired');
    expect(sweep.purgeHardFilteredSuggestions).not.toHaveBeenCalled();
    expect(sweep.unexcludeRetiredHardFilters).not.toHaveBeenCalled();
  });

  it('reverting a topic mutation runs no sweep but still marks the feed dirty', async () => {
    db._setRows('topics', [makeRecord({ id: 't1', status: 'active', weight: 0.5 })]);
    const retiredTopic = await applyPersonaAction(
      { action_type: ACTION_NAMES.RETIRE_TOPIC, topicId: 't1' },
      'user',
    );
    mockSetFeedNeedsRefresh.mockClear();

    await revertChange(retiredTopic.changeLogId!);
    expect(db._collections['topics']._rows[0].status).toBe('active');

    expect(sweep.purgeHardFilteredSuggestions).not.toHaveBeenCalled();
    expect(sweep.unexcludeRetiredHardFilters).not.toHaveBeenCalled();
    // D18: reverting a weight is exactly as score-affecting as setting one.
    expect(mockSetFeedNeedsRefresh).toHaveBeenCalledWith(true);
  });

  it('a sweep failure never fails the revert (it is already committed)', async () => {
    const added = await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'cricket',
        suppressionStrength: 0.9,
      },
      'user',
    );
    (sweep.unexcludeRetiredHardFilters as jest.Mock).mockRejectedValueOnce(new Error('boom'));

    await expect(revertChange(added.changeLogId!)).resolves.toBeUndefined();
    expect(supRows()[0].status).toBe('retired');
    // The undo still landed and was audited.
    expect(logRows().some((r: any) => r.actionType === 'revert_change')).toBe(true);
  });
});

describe('retire_suppression revert (soft, keyword)', () => {
  it('restores a soft keyword filter without touching its original expiry', async () => {
    const added = await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'celebrity gossip',
        suppressionKeywords: ['celebrity', 'gossip'],
        suppressionStrength: 0.5,
      },
      'feedback',
    );
    expect(added.applied).toBe(true);

    const stored = supRows()[0];
    expect(stored.kind).toBeNull(); // NULL ⇒ reads as 'keyword'
    const originalExpiry = stored.expiresAt;
    expect(typeof originalExpiry).toBe('number'); // soft ⇒ +30d
    // Soft ⇒ neither sweep ran.
    expect(sweep.purgeHardFilteredSuggestions).not.toHaveBeenCalled();

    const retired = await applyPersonaAction(
      { action_type: ACTION_NAMES.RETIRE_SUPPRESSION, suppressionId: stored.id },
      'user',
    );
    expect(stored.status).toBe('retired');
    // Soft ⇒ nothing was ever hard-excluded, so no release sweep.
    expect(sweep.unexcludeRetiredHardFilters).not.toHaveBeenCalled();

    await revertChange(retired.changeLogId!);
    expect(stored.status).toBe('active');
    expect(stored.expiresAt).toBe(originalExpiry);
  });

  it('reverting twice is a no-op (the row is already marked reverted)', async () => {
    const added = await applyPersonaAction(
      { action_type: ACTION_NAMES.ADD_SUPPRESSION, suppressionPattern: 'gossip' },
      'user',
    );
    const stored = supRows()[0];
    const retired = await applyPersonaAction(
      { action_type: ACTION_NAMES.RETIRE_SUPPRESSION, suppressionId: stored.id },
      'user',
    );
    await revertChange(retired.changeLogId!);
    await expect(revertChange(retired.changeLogId!)).resolves.toBeUndefined();
    expect(stored.status).toBe('active');
    expect(added.applied).toBe(true);
  });
});
