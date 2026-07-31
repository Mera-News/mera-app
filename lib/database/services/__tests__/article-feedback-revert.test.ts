// Un-voting reverts what the verdict's leaf applied (D15/D16, PU-9).
//
// Once a terminal feedback-tree leaf applies persona mutations on the spot, an
// un-vote that only deletes the verdict row would leave "unfilled" meaning
// "this changed your persona, and the change is still in force" — the same
// UI-says-one-thing / persona-says-another problem the wave exists to remove.
//
// The end-to-end case uses the REAL executor + persona-change-log-service
// against the fake WatermelonDB (the pattern from
// persona-action-executor-suppression-revert.test.ts), so the whole loop is
// exercised: a leaf mints a HARD filter → the ids are recorded on the verdict
// row → un-voting retires the filter AND runs the un-exclude sweep that resets
// the rows the filter had excluded. The sweep itself is Phase 3's contract and
// is asserted at its seam, not re-implemented here.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(() => 'evt'),
    addBreadcrumb: jest.fn(),
  },
}));

jest.mock('@/lib/services/suppression-sweep', () => ({
  purgeHardFilteredSuggestions: jest.fn(async () => ({
    excludedIds: ['sugg-1'],
    valueById: new Map(),
    evictedFromFeed: 1,
  })),
  unexcludeRetiredHardFilters: jest.fn(async () => ({ resetIds: ['sugg-1'], stillExcluded: 0 })),
}));

jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: { getState: () => ({ setFeedNeedsRefresh: jest.fn() }) },
}));

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import logger from '@/lib/logger';
import { applyPersonaAction } from '../persona-action-executor';
import * as changeLog from '../persona-change-log-service';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import * as sweep from '@/lib/services/suppression-sweep';
import {
  recordFeedbackChangeLogIds,
  removeArticleFeedback,
} from '../article-feedback-service';

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

function makeVerdictRow(overrides: Record<string, unknown> = {}) {
  return makeRecord({
    id: 'fb-1',
    articleId: 'a1',
    sentiment: 'dislike',
    title: 'A story',
    contextJson: null,
    createdAt: new Date(),
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('article_feedback', []);
  db._setRows('persona_suppressions', []);
  db._setRows('persona_change_log', []);
  withIds('persona_suppressions', 'sup');
  withIds('persona_change_log', 'cl');
});

// ---------------------------------------------------------------------------
// recordFeedbackChangeLogIds
// ---------------------------------------------------------------------------

describe('recordFeedbackChangeLogIds', () => {
  it('merges the ids into the same context_json snapshot as treePath', async () => {
    const row = makeVerdictRow({ contextJson: '{"treePath":["suggestion","not_important"]}' });
    db._setRows('article_feedback', [row]);

    await recordFeedbackChangeLogIds('a1', 'dislike', ['cl-1', 'cl-2']);

    expect(JSON.parse(row.contextJson)).toEqual({
      treePath: ['suggestion', 'not_important'],
      changeLogIds: ['cl-1', 'cl-2'],
    });
  });

  it('ACCUMULATES across leaves and de-dupes — a user can pick more than one', async () => {
    const row = makeVerdictRow({ contextJson: '{"changeLogIds":["cl-1"]}' });
    db._setRows('article_feedback', [row]);

    await recordFeedbackChangeLogIds('a1', 'dislike', ['cl-1', 'cl-2']);

    expect(JSON.parse(row.contextJson).changeLogIds).toEqual(['cl-1', 'cl-2']);
  });

  it('is a no-op for an empty id list or a missing row', async () => {
    db._setRows('article_feedback', [makeVerdictRow()]);
    await recordFeedbackChangeLogIds('a1', 'dislike', []);
    expect(database.write).not.toHaveBeenCalled();

    db._setRows('article_feedback', []);
    await recordFeedbackChangeLogIds('a1', 'dislike', ['cl-1']);
    expect(database.write).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// removeArticleFeedback → revert
// ---------------------------------------------------------------------------

describe('un-vote reverts the applied change', () => {
  it('reverts every stored change-log id and still deletes the row', async () => {
    const spy = jest.spyOn(changeLog, 'revertChange').mockResolvedValue(undefined as never);
    const row = makeVerdictRow({ contextJson: '{"changeLogIds":["cl-1","cl-2"]}' });
    db._setRows('article_feedback', [row]);

    await removeArticleFeedback('a1', 'dislike');

    expect(row.destroyPermanently).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith('cl-1');
    expect(spy).toHaveBeenCalledWith('cl-2');
    spy.mockRestore();
  });

  it('reverts nothing for a verdict that never committed (no ids)', async () => {
    const spy = jest.spyOn(changeLog, 'revertChange');
    db._setRows('article_feedback', [makeVerdictRow({ contextJson: '{"treePath":[]}' })]);

    await removeArticleFeedback('a1', 'dislike');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('PARTIAL failure: reverts what it can, never throws, logs the shortfall', async () => {
    const spy = jest
      .spyOn(changeLog, 'revertChange')
      .mockRejectedValueOnce(new Error('cannot invert'))
      .mockResolvedValueOnce(undefined as never);
    const row = makeVerdictRow({ contextJson: '{"changeLogIds":["cl-bad","cl-good"]}' });
    db._setRows('article_feedback', [row]);

    await expect(removeArticleFeedback('a1', 'dislike')).resolves.toBeUndefined();

    // The good one still went through — no all-or-nothing rollback.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith('cl-good');
    // The un-vote itself succeeded regardless.
    expect(row.destroyPermanently).toHaveBeenCalledTimes(1);
    expect(logger.captureException).toHaveBeenCalledTimes(1);
    expect(logger.addBreadcrumb).toHaveBeenCalledWith(
      expect.stringContaining('reverted only part'),
      'article-feedback',
      expect.objectContaining({ reverted: 1, total: 2 }),
      'warning',
    );
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// End to end: a leaf that mints a HARD filter, then an un-vote
// ---------------------------------------------------------------------------

describe('end to end — un-voting a leaf that minted a hard filter', () => {
  it('retires the filter and releases the rows it had excluded', async () => {
    // 1. A terminal leaf applies a HARD filter (strength ≥ 0.8) and the stored
    //    feed is purged retroactively.
    const added = await applyPersonaAction(
      {
        action_type: ACTION_NAMES.ADD_SUPPRESSION,
        suppressionPattern: 'Daily Blether',
        suppressionKind: 'publication',
        suppressionValue: 'Daily Blether',
        suppressionStrength: 0.9,
      },
      'feedback',
    );
    expect(added.applied).toBe(true);
    const filter = db._collections['persona_suppressions']._rows[0];
    expect(filter.status).toBe('active');
    expect(sweep.purgeHardFilteredSuggestions).toHaveBeenCalledTimes(1);

    // 2. The verdict row remembers what the leaf changed.
    const row = makeVerdictRow({ contextJson: '{"treePath":["publication_content"]}' });
    db._setRows('article_feedback', [row]);
    await recordFeedbackChangeLogIds('a1', 'dislike', [added.changeLogId as string]);
    expect(JSON.parse(row.contextJson).changeLogIds).toEqual([added.changeLogId]);

    // 3. Un-vote. The verdict goes, the filter goes with it, and the sweep that
    //    releases the previously-excluded rows runs — inherited from Phase 3's
    //    revertChange, not re-implemented here.
    await removeArticleFeedback('a1', 'dislike');

    expect(row.destroyPermanently).toHaveBeenCalledTimes(1);
    expect(filter.status).toBe('retired');
    expect(sweep.unexcludeRetiredHardFilters).toHaveBeenCalledTimes(1);
  });
});
