// Undo and revert are COMPARE-AND-SET for source preferences (batch 16).
// An undo restores its `before` only while the current value is still the one
// that action set; otherwise a newer action owns the value and the undo is a
// no-op. Real executor + change log + preference service on the fake DB.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(() => 'evt') },
}));

// Additive (P3): a `mute` now triggers the retroactive purge and an unmute the
// release; both are lazily required by the executor. Stubbed so this stays a
// pref-round-trip test.
jest.mock('@/lib/services/suppression-sweep', () => ({
  purgeHardFilteredSuggestions: jest.fn(async () => ({
    excludedIds: [],
    valueById: new Map(),
    evictedFromFeed: 0,
  })),
  unexcludeRetiredHardFilters: jest.fn(async () => ({ resetIds: [], stillExcluded: 0 })),
}));

// Additive (P3): every applied mutation now marks the feed dirty (D18).
jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: { getState: () => ({ setFeedNeedsRefresh: jest.fn() }) },
}));

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import { applyPersonaAction } from '../persona-action-executor';
import { revertChange } from '../persona-change-log-service';
import { setSourcePrefFromUi } from '../publication-pref-ui-actions';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';

const db = database as any;
const NOW = new Date('2024-01-01T00:00:00.000Z');

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

const prefsRows = () => db._collections['publication_preferences']._rows as any[];
const findPref = (name: string) => prefsRows().find((p) => p.publicationName === name);

beforeEach(() => {
  jest.clearAllMocks();
  // Touch the collections so the service handles exist, then reset.
  db._setRows('publication_preferences', []);
  db._setRows('persona_change_log', []);
  withIds('publication_preferences', 'pref');
  withIds('persona_change_log', 'cl');
});


const logRows = () => db._collections['persona_change_log']._rows as any[];
const kindOf = (name: string) => {
    const p = findPref(name);
    if (!p || p.status !== 'active') return 'none';
    return p.weight > 0 ? 'boost' : p.weight <= -1 ? 'mute' : 'deprioritize';
};

describe('publication preference undo is compare-and-set', () => {
    it('the batch 16 sequence: a stale undo never clobbers a newer change', async () => {
        // 1. Fewer from IT Pro: none -> deprioritize.
        const fewer = await setSourcePrefFromUi({ kind: 'publication', publicationName: 'IT Pro' }, 'deprioritised');
        expect(fewer.applied).toBe(true);
        expect(fewer.changeLogId).toBeDefined();
        expect(kindOf('IT Pro')).toBe('deprioritize');

        // 2. Like -> "More from this publication": deprioritize -> boost.
        const boost = await applyPersonaAction(
            { action_type: ACTION_NAMES.SET_PUBLICATION_PREF, publicationId: 'IT Pro', publicationPref: 'boost' },
            'feedback',
        );
        expect(kindOf('IT Pro')).toBe('boost');
        const rowsBefore = logRows().length;

        // 3. Undo on the Fewer toast: the boost owns the value now -> no-op.
        await expect(revertChange(fewer.changeLogId!)).resolves.toBe(false);
        expect(kindOf('IT Pro')).toBe('boost');
        expect(logRows().find((r) => r.id === fewer.changeLogId).reverted).toBe(false);
        expect(logRows().length).toBe(rowsBefore); // nothing logged, no fresh user action

        // 4. Undo on the "Got it" toast: the boost still holds -> restores deprioritize, as a revert.
        await expect(revertChange(boost.changeLogId!)).resolves.toBe(true);
        expect(kindOf('IT Pro')).toBe('deprioritize');
        expect(logRows().find((r) => r.id === boost.changeLogId).reverted).toBe(true);
        expect(logRows().some((r) => r.actionType === 'revert_change')).toBe(true);

        // 5. Remove like -> the spend revert of the same change: already reverted -> no-op.
        await expect(revertChange(boost.changeLogId!)).resolves.toBe(false);
        expect(kindOf('IT Pro')).toBe('deprioritize');
    });

    it('a single undo still restores the prior value', async () => {
        const fewer = await setSourcePrefFromUi({ kind: 'publication', publicationName: 'AD.nl' }, 'deprioritised');
        await expect(revertChange(fewer.changeLogId!)).resolves.toBe(true);
        expect(kindOf('AD.nl')).toBe('none');
        expect(logRows().find((r) => r.id === fewer.changeLogId).reverted).toBe(true);
    });

    it('a country scope follows the same rule', async () => {
        const first = await applyPersonaAction(
            {
                action_type: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
                scopeKind: 'country',
                scopeValue: 'NLD',
                scopeLabel: 'Netherlands',
                publicationPref: 'boost',
            },
            'user',
        );
        await applyPersonaAction(
            {
                action_type: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
                scopeKind: 'country',
                scopeValue: 'NLD',
                scopeLabel: 'Netherlands',
                publicationPref: 'deprioritize',
            },
            'user',
        );
        await expect(revertChange(first.changeLogId!)).resolves.toBe(false);
    });
});
