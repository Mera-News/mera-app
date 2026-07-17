// set_publication_pref apply + revert round-trip.
//
// Unlike persona-action-executor.test.ts (services mocked), this wires the REAL
// executor, persona-change-log-service, and publication-preference-service to
// the fake WatermelonDB so the full loop — apply a pref, then revertChange —
// is exercised end to end, proving the new invert-map branch is correct.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(() => 'evt') },
}));

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import { applyPersonaAction } from '../persona-action-executor';
import { revertChange } from '../persona-change-log-service';
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

describe('set_publication_pref round-trip (prior pref exists)', () => {
  beforeEach(() => {
    db._setRows('publication_preferences', [
      makeRecord({
        id: 'pref-seed',
        publicationName: 'The Times',
        sourceCountryCode: null,
        weight: 0.5, // boost
        status: 'active',
        provenance: 'user',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ]);
  });

  it('applies mute over a prior boost, then revert restores the boost weight', async () => {
    const res = await applyPersonaAction(
      {
        action_type: ACTION_NAMES.SET_PUBLICATION_PREF,
        publicationId: 'The Times',
        publicationPref: 'mute',
      },
      'feedback',
    );

    expect(res.applied).toBe(true);
    expect(res.changeLogId).toBeDefined();
    // mute → weight -1
    expect(findPref('The Times').weight).toBe(-1);

    // The logged row captured before='boost', after='mute'.
    const logRow = db._collections['persona_change_log']._rows.find(
      (r: any) => r.id === res.changeLogId,
    );
    expect(JSON.parse(logRow.actionJson)).toMatchObject({
      targetId: 'The Times',
      before: 'boost',
      after: 'mute',
    });

    // Revert → restores the prior boost weight (0.5) and marks the row reverted.
    await revertChange(res.changeLogId!);
    expect(findPref('The Times').weight).toBe(0.5);
    expect(logRow.reverted).toBe(true);
  });
});

describe('set_publication_pref round-trip (no prior pref)', () => {
  it("applies boost from 'none', then revert clears (retires) the preference", async () => {
    const res = await applyPersonaAction(
      {
        action_type: ACTION_NAMES.SET_PUBLICATION_PREF,
        publicationId: 'The Times',
        publicationPref: 'boost',
      },
      'feedback',
    );

    expect(res.applied).toBe(true);
    const created = findPref('The Times');
    expect(created.weight).toBe(0.5);
    expect(created.status).toBe('active');

    const logRow = db._collections['persona_change_log']._rows.find(
      (r: any) => r.id === res.changeLogId,
    );
    expect(JSON.parse(logRow.actionJson)).toMatchObject({ before: 'none', after: 'boost' });

    // Revert of a 'none' prior → the preference is retired (cleared).
    await revertChange(res.changeLogId!);
    expect(findPref('The Times').status).toBe('retired');
  });
});
