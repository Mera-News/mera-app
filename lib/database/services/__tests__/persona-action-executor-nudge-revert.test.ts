// Un-vote round trip for the rails-backed leaves (P3c).
//
// THE BUG THIS PINS: three dispatch cases delegate to a mutation-rails helper
// that appends the persona_change_log row ITSELF, and the case dropped the id
// on the floor. The feedback layer stores the ids a leaf minted onto the
// verdict row and un-voting reverts exactly those, so `recordFeedbackChangeLogIds`
// received [] and early-returned: the thumb went hollow while the persona
// change stayed applied forever. That is exactly the ambiguity the fill-state
// contract ("filled means it changed your persona") exists to remove.
//
// A test on the return value alone is not enough — it would pass against a
// fabricated id. So this wires the REAL executor, mutation-rails-service,
// change-log service and topic-service to the fake WatermelonDB and drives the
// whole loop: apply the leaf → capture the id the way the feedback layer does
// → revertChange(id) → assert the persona value is actually back.

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

const db = database as any;

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

const topic = () => db._collections['topics']._rows[0];
const fact = () => db._collections['facts']._rows[0];

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('topics', [
    makeRecord({ id: 't1', weight: 0.5, highPriority: false, status: 'active' }),
  ]);
  db._setRows('facts', [makeRecord({ id: 'f1', weight: 0.8 })]);
  db._setRows('persona_change_log', []);
  withIds('persona_change_log', 'cl');
});

// ---------------------------------------------------------------------------
// set_topic_weight — the DELTA branch (not_important, wrong_topic,
// a_lot_more, a_bit_more — the most-used leaves in the tree)
// ---------------------------------------------------------------------------

describe('topic-weight nudge → un-vote', () => {
  it('returns the change-log id the un-vote path needs', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't1', delta: -0.15 },
      'feedback',
    );

    expect(res.applied).toBe(true);
    // The regression: this was undefined, so the feedback layer recorded []
    // and un-voting silently did nothing.
    expect(res.changeLogId).toBeDefined();
    expect(topic().weight).toBeCloseTo(0.35);
  });

  it('the id actually reverts the weight (full round trip)', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't1', delta: -0.15 },
      'feedback',
    );
    expect(topic().weight).toBeCloseTo(0.35);

    // Exactly what un-voting does: revert every id the leaf recorded.
    const recordedIds = [res.changeLogId].filter(Boolean) as string[];
    expect(recordedIds).toHaveLength(1); // would have been 0 before the fix
    for (const id of recordedIds) await revertChange(id);

    expect(topic().weight).toBeCloseTo(0.5);
  });

  it('appends no id and needs no revert when the budget is exhausted', async () => {
    // Pre-spend the whole 0.3/day budget on this topic.
    db._setRows('persona_change_log', [
      makeRecord({
        id: 'cl-seed',
        actionType: ACTION_NAMES.SET_TOPIC_WEIGHT,
        actionJson: JSON.stringify({ targetId: 't1', delta: -0.3 }),
        createdAt: new Date(),
      }),
    ]);

    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't1', delta: -0.15 },
      'feedback',
    );

    expect(res.applied).toBe(false);
    expect(res.changeLogId).toBeUndefined();
    expect(topic().weight).toBeCloseTo(0.5); // untouched
  });
});

// ---------------------------------------------------------------------------
// The same defect shape in the two neighbouring rails-backed cases
// ---------------------------------------------------------------------------

describe('set_high_priority → un-vote', () => {
  it('round-trips the pin back off', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_HIGH_PRIORITY, topicId: 't1', highPriority: true },
      'feedback',
    );

    expect(res.changeLogId).toBeDefined();
    expect(topic().highPriority).toBe(true);

    await revertChange(res.changeLogId!);
    expect(topic().highPriority).toBe(false);
  });

  it('a no-op pin reports applied with no id (nothing was logged to revert)', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_HIGH_PRIORITY, topicId: 't1', highPriority: false },
      'feedback',
    );
    expect(res.changeLogId).toBeUndefined();
    expect(db._collections['persona_change_log']._rows).toHaveLength(0);
  });
});

describe('set_fact_weight → un-vote', () => {
  it('round-trips the fact weight back', async () => {
    const res = await applyPersonaAction(
      { action_type: ACTION_NAMES.SET_FACT_WEIGHT, factId: 'f1', delta: -0.2 },
      'feedback',
    );

    expect(res.changeLogId).toBeDefined();
    expect(fact().weight).toBeCloseTo(0.6);

    await revertChange(res.changeLogId!);
    expect(fact().weight).toBeCloseTo(0.8);
  });
});

// ---------------------------------------------------------------------------
// The invariant the whole fill-state contract rests on
// ---------------------------------------------------------------------------

describe('invariant: an applied persona mutation is always un-votable', () => {
  it('every rails-backed leaf returns an id whenever it changed the persona', async () => {
    const cases = [
      { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't1', delta: -0.15 },
      { action_type: ACTION_NAMES.SET_TOPIC_WEIGHT, topicId: 't1', weight: 0.9 },
      { action_type: ACTION_NAMES.SET_HIGH_PRIORITY, topicId: 't1', highPriority: true },
      { action_type: ACTION_NAMES.SET_FACT_WEIGHT, factId: 'f1', delta: -0.2 },
    ] as const;

    for (const action of cases) {
      db._setRows('topics', [
        makeRecord({ id: 't1', weight: 0.5, highPriority: false, status: 'active' }),
      ]);
      db._setRows('facts', [makeRecord({ id: 'f1', weight: 0.8 })]);
      db._setRows('persona_change_log', []);
      withIds('persona_change_log', 'cl');

      const res = await applyPersonaAction({ ...action }, 'feedback');
      expect(res.applied).toBe(true);
      // If this fails, that leaf can be cast but never un-cast.
      expect(res.changeLogId).toBeDefined();
    }
  });
});
