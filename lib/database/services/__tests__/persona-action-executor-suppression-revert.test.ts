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

jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: { getState: () => ({ setFeedNeedsRefresh: jest.fn() }) },
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

    // 3. Undo the removal — the filter comes back active.
    await revertChange(retired.changeLogId!);
    expect(stored.status).toBe('active');
    expect(logRow.reverted).toBe(true);
    // …and a revert_change audit row was appended.
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
