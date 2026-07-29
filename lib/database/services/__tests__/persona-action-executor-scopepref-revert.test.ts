// set_source_scope_pref apply + revert round-trip (source-pref v47, D2/D6).
//
// Same shape as persona-action-executor-pubpref-revert.test.ts: the REAL
// executor, persona-change-log-service and publication-preference-service are
// wired to the fake WatermelonDB so the whole loop runs end to end.
//
// The revert half is not optional coverage. `isRevertible` in
// components/custom/persona-audit/action-display.ts is a DENY-list, so an
// Activity row for this action type already renders an Undo button; without the
// inverse case in persona-change-log-service that button can only produce an
// error toast. These tests are what prove the button works.

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
import { append as appendChange } from '../persona-change-log-service';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';

const db = database as any;
const NOW = new Date('2024-01-01T00:00:00.000Z');

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
const findScope = (value: string) =>
  prefsRows().find((p) => p.scopeKind === 'country' && p.scopeValue === value);
const logRowFor = (id?: string) =>
  db._collections['persona_change_log']._rows.find((r: any) => r.id === id);

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('publication_preferences', []);
  db._setRows('persona_change_log', []);
  withIds('publication_preferences', 'pref');
  withIds('persona_change_log', 'cl');
});

describe('set_source_scope_pref — apply', () => {
  it("creates the scope row from 'none', logging the composite targetId and the label", async () => {
    const res = await applyPersonaAction(
      {
        action_type: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
        scopeKind: 'country',
        scopeValue: 'IND',
        scopeLabel: 'India',
        publicationPref: 'boost',
      },
      'chat',
    );

    expect(res.applied).toBe(true);
    const row = findScope('IND');
    expect(row.weight).toBe(0.5); // boost
    expect(row.status).toBe('active');
    // D6: the human label rides in publication_name so the existing
    // Source-preferences screen renders the row with no branch.
    expect(row.publicationName).toBe('India');

    // The encoding the Source-preferences screen also writes — a scope has no
    // row id for the log to point at, so targetId must rebuild the whole ref.
    expect(JSON.parse(logRowFor(res.changeLogId).actionJson)).toMatchObject({
      targetId: 'country:IND',
      before: 'none',
      after: 'boost',
      label: 'India',
    });
  });

  it('is a NO-OP for mute — nothing implements a scope exclusion', async () => {
    const res = await applyPersonaAction(
      {
        action_type: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
        scopeKind: 'country',
        scopeValue: 'IND',
        scopeLabel: 'India',
        publicationPref: 'mute',
      },
      'chat',
    );
    expect(res.applied).toBe(false);
    expect(res.summary).toContain('cannot be muted');
    expect(prefsRows()).toHaveLength(0);
    expect(db._collections['persona_change_log']._rows).toHaveLength(0);
  });

  it('skips (never throws) when the scope is incomplete', async () => {
    for (const action of [
      { action_type: ACTION_NAMES.SET_SOURCE_SCOPE_PREF, scopeValue: 'IND', publicationPref: 'boost' },
      { action_type: ACTION_NAMES.SET_SOURCE_SCOPE_PREF, scopeKind: 'country', publicationPref: 'boost' },
      { action_type: ACTION_NAMES.SET_SOURCE_SCOPE_PREF, scopeKind: 'country', scopeValue: 'IND' },
    ] as any[]) {
      const res = await applyPersonaAction(action, 'chat');
      expect(res.applied).toBe(false);
    }
    expect(prefsRows()).toHaveLength(0);
  });

  it('never collides with a NAMED publication that happens to share the label', async () => {
    // A publication literally called "India" must stay a separate row — the
    // scope_kind discriminator is the only thing keeping them apart (D6).
    db._setRows('publication_preferences', [
      makeRecord({
        id: 'pref-named',
        publicationName: 'India',
        scopeKind: null,
        scopeValue: null,
        weight: -0.5,
        status: 'active',
        provenance: 'user',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ]);
    withIds('publication_preferences', 'pref');

    await applyPersonaAction(
      {
        action_type: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
        scopeKind: 'country',
        scopeValue: 'IND',
        scopeLabel: 'India',
        publicationPref: 'boost',
      },
      'chat',
    );

    expect(prefsRows()).toHaveLength(2);
    expect(prefsRows().find((p: any) => p.id === 'pref-named').weight).toBe(-0.5);
    expect(findScope('IND').weight).toBe(0.5);
  });
});

describe('set_source_scope_pref — revert', () => {
  it("undoing a create retires the scope row (prior 'none')", async () => {
    const res = await applyPersonaAction(
      {
        action_type: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
        scopeKind: 'country',
        scopeValue: 'IND',
        scopeLabel: 'India',
        publicationPref: 'boost',
      },
      'chat',
    );

    await expect(revertChange(res.changeLogId!)).resolves.toBeUndefined();
    expect(findScope('IND').status).toBe('retired');
    expect(logRowFor(res.changeLogId).reverted).toBe(true);
  });

  it('undoing a change restores the PRIOR kind and its label', async () => {
    await applyPersonaAction(
      {
        action_type: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
        scopeKind: 'country',
        scopeValue: 'DEU',
        scopeLabel: 'Germany',
        publicationPref: 'boost',
      },
      'chat',
    );
    const second = await applyPersonaAction(
      {
        action_type: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
        scopeKind: 'country',
        scopeValue: 'DEU',
        scopeLabel: 'Germany',
        publicationPref: 'deprioritize',
      },
      'chat',
    );
    expect(findScope('DEU').weight).toBe(-0.5);

    await revertChange(second.changeLogId!);
    expect(findScope('DEU').weight).toBe(0.5); // back to boost
    expect(findScope('DEU').status).toBe('active');
    expect(findScope('DEU').publicationName).toBe('Germany');
  });

  it('reverts a row written directly by the Source-preferences screen', async () => {
    // The screen hand-appends its own change-log rows with the same encoding —
    // the inverse must work on those too, not only on executor-written ones.
    db._setRows('publication_preferences', [
      makeRecord({
        id: 'pref-seed',
        publicationName: 'India',
        scopeKind: 'country',
        scopeValue: 'IND',
        weight: -0.5, // deprioritize
        status: 'active',
        provenance: 'user',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ]);
    withIds('publication_preferences', 'pref');

    const row = await appendChange({
      actionType: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
      action: { targetId: 'country:IND', before: 'boost', after: 'deprioritize', label: 'India' },
      source: 'user',
      summary: 'Set source preference: India → deprioritize',
    });

    await revertChange(row.id);
    expect(findScope('IND').weight).toBe(0.5);
  });

  it('refuses a malformed targetId rather than silently mutating the wrong row', async () => {
    const bad = await appendChange({
      actionType: ACTION_NAMES.SET_SOURCE_SCOPE_PREF,
      action: { targetId: 'IND', before: 'none', after: 'boost' },
      source: 'user',
      summary: 'bad',
    });
    await expect(revertChange(bad.id)).rejects.toThrow('scopeKind');
  });
});
