// article-suggestion-service scoring writes: saveScoringResult, saveReason, the batch markers and
// score propagation, including the grounded-reason rule and the per-row scorer vintage. Real
// services on the in-memory DB, so a write is read back as the next reader sees it. Replaces the
// scoring-write blocks of lib/database/services/__tests__/article-suggestion-service.test.ts.
import logger from '@/lib/logger';
import {
  batchMarkAsScoredByIds,
  batchMarkExcluded,
  batchMarkGateSkipped,
  batchMarkReasonSkipped,
  batchPropagateScores,
  batchResetToUnscored,
  saveReason,
  saveScoringResult,
} from '@/lib/database/services/article-suggestion-scoring-writes';
import { deleteSuggestionsByServerIds } from '@/lib/database/services/article-suggestion-lifecycle';
import { FOREIGN, GROUNDED, HOUR, T0, article, freezeClock, row, seed, toComplete, toExcluded, toReasonPending, withVintage } from './support';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

beforeEach(() => freezeClock());

const snapshot = async (id: string) => {
  const r = await row(id);
  return {
    status: r.status,
    relevance: r.relevance,
    reason: r.reason,
    scoredAt: r.scoredAt,
    rawScore: r.rawScore,
    computedScore: r.computedScore,
    scoreComponentsJson: r.scoreComponentsJson,
    scoredWithV3: r.scoredWithV3,
  };
};

describe('saveScoringResult', () => {
  it('lands complete when a note came with the score', async () => {
    await seed([article('a1')]);

    await saveScoringResult('a1', { relevance: 0.8, reason: GROUNDED, reasonSkipped: false });

    expect(await snapshot('a1')).toMatchObject({ status: 'complete', relevance: 0.8, reason: GROUNDED, scoredAt: T0, scoredWithV3: false });
  });

  it('lands reason_pending when the note is empty and one is still owed', async () => {
    await seed([article('a1')]);

    await saveScoringResult('a1', { relevance: 0.5, reason: '', reasonSkipped: false });

    expect(await snapshot('a1')).toMatchObject({ status: 'reason_pending', relevance: 0.5, reason: '' });
  });

  it('lands complete with no note when none was owed (reasonSkipped)', async () => {
    await seed([article('a1')]);

    await saveScoringResult('a1', { relevance: 0.1, reason: '', reasonSkipped: true });

    expect(await snapshot('a1')).toMatchObject({ status: 'complete', relevance: 0.1, reason: '' });
  });

  it('stamps scored_at once: a later write does not slide the "added" time forward', async () => {
    await seed([article('a1')]);
    await toReasonPending('a1');
    jest.setSystemTime(T0 + HOUR);

    await saveScoringResult('a1', { relevance: 0.9, reason: GROUNDED, reasonSkipped: false });

    expect((await snapshot('a1')).scoredAt).toBe(T0);
  });

  it('writes the audit columns only when given, and keeps them through a later write without', async () => {
    await seed([article('a1')]);
    await saveScoringResult('a1', {
      relevance: 0.6,
      reason: '',
      reasonSkipped: false,
      computedScore: 0.55,
      rawScore: 0.62,
      scoreComponentsJson: '{"mode":"math"}',
    });
    await saveScoringResult('a1', { relevance: 0.7, reason: GROUNDED, reasonSkipped: false });

    expect(await snapshot('a1')).toMatchObject({
      relevance: 0.7,
      computedScore: 0.55,
      rawScore: 0.62,
      scoreComponentsJson: '{"mode":"math"}',
    });
  });

  it('rejects for a row that is not there (callers treat a missing record as a delete mid-flight)', async () => {
    await expect(saveScoringResult('gone', { relevance: 0.5, reason: '', reasonSkipped: false })).rejects.toThrow();
  });
});

describe('the grounded-reason rule', () => {
  it('saveScoringResult keeps the score but drops a note about another article, and logs which writer asked', async () => {
    await seed([article('a1')]);

    await saveScoringResult('a1', { relevance: 0.9077, reason: FOREIGN, reasonSkipped: false });

    // Owed a real note, not terminal: the orphaned-reason sweep will retry it.
    expect(await snapshot('a1')).toMatchObject({ status: 'reason_pending', relevance: 0.9077, reason: '' });
    expect(logger.warn).toHaveBeenCalledWith(
      '[article-suggestion-service] dropped an ungrounded reason',
      expect.objectContaining({ source: 'score', suggestionId: 'a1' }),
    );
  });

  it('saveScoringResult still lands terminal when no note was owed at all', async () => {
    await seed([article('a1')]);

    await saveScoringResult('a1', { relevance: 0.1, reason: FOREIGN, reasonSkipped: true });

    expect(await snapshot('a1')).toMatchObject({ status: 'complete', reason: '' });
  });

  it('saveReason drops it and leaves the row for the next sweep', async () => {
    await seed([article('a1')]);
    await toReasonPending('a1');

    await saveReason('a1', FOREIGN);

    expect(await snapshot('a1')).toMatchObject({ status: 'reason_pending', reason: '' });
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ source: 'reason-sweep' }));
  });

  it('batchPropagateScores rejects a donor sentence that is false on the recipient but still copies the score', async () => {
    await seed([article('a1')]);

    await batchPropagateScores([{ id: 'a1', relevance: 0.72, reason: FOREIGN }]);

    // Grouping is evidence about the story, so the relevance propagates.
    expect(await snapshot('a1')).toMatchObject({ relevance: 0.72, reason: '', status: 'reason_pending' });
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ source: 'propagation' }));
  });

  it('does not judge a row whose article text never arrived', async () => {
    await seed([article('a1', { title_en: null as never, description_en: null })]);

    await saveScoringResult('a1', { relevance: 0.8, reason: FOREIGN, reasonSkipped: false });

    // Nothing to compare against: keep. A rejection here would be a coin flip.
    expect(await snapshot('a1')).toMatchObject({ status: 'complete', reason: FOREIGN });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('counts an extracted entity as article text', async () => {
    await seed([article('a1', { entities: ['Bundestag'] })]);

    await saveReason('a1', 'The Bundestag vote changes your tax bill.');

    expect((await snapshot('a1')).status).toBe('complete');
  });

  it('counts a tagged place as article text', async () => {
    await seed([article('a1', { geo_tags: [{ city: 'Utrecht', countryCode: 'NLD' }] as never })]);

    await saveReason('a1', 'Utrecht is where you live.');

    expect((await snapshot('a1')).status).toBe('complete');
  });
});

describe('saveReason', () => {
  it('writes the note and completes the row, leaving the score alone', async () => {
    await seed([article('a1')]);
    await toReasonPending('a1', 0.7);

    await saveReason('a1', GROUNDED);

    expect(await snapshot('a1')).toMatchObject({ status: 'complete', reason: GROUNDED, relevance: 0.7, scoredAt: T0 });
  });

  it('keeps the row reason_pending for an empty note', async () => {
    await seed([article('a1')]);
    await toComplete('a1');

    await saveReason('a1', '');

    expect(await snapshot('a1')).toMatchObject({ status: 'reason_pending', reason: '' });
  });
});

describe('batchMarkAsScoredByIds', () => {
  it('writes relevance 0, an empty note and complete', async () => {
    await seed([article('a1'), article('a2')]);
    await toComplete('a1');

    await batchMarkAsScoredByIds(['a1', 'a2']);

    for (const id of ['a1', 'a2']) {
      expect(await snapshot(id)).toMatchObject({ status: 'complete', relevance: 0, reason: '' });
    }
  });

  it('tolerates a row deleted mid-flight: updates the survivors, no throw', async () => {
    await seed([article('a1')]);

    await expect(batchMarkAsScoredByIds(['a1', 'gone'])).resolves.toBeUndefined();

    expect((await snapshot('a1')).status).toBe('complete');
  });

  it('is a no-op for no ids, or only missing ones', async () => {
    await expect(batchMarkAsScoredByIds([])).resolves.toBeUndefined();
    await expect(batchMarkAsScoredByIds(['gone-1', 'gone-2'])).resolves.toBeUndefined();
  });
});

describe('batchMarkExcluded', () => {
  it('zeroes every score, clears the note and writes the terminal status', async () => {
    await seed([article('a1')]);
    await saveScoringResult('a1', { relevance: 0.8, reason: GROUNDED, reasonSkipped: false, computedScore: 0.5, rawScore: 0.6 });

    await batchMarkExcluded(['a1'], T0 + HOUR);

    expect(await snapshot('a1')).toMatchObject({ status: 'excluded', relevance: 0, reason: '', rawScore: 0, computedScore: 0 });
  });

  it('stamps scored_at only when it is still null: a purge sweep does not slide an existing time', async () => {
    await seed([article('scored'), article('fresh')]);
    await toComplete('scored');

    await batchMarkExcluded(['scored', 'fresh'], T0 + HOUR);

    expect((await snapshot('scored')).scoredAt).toBe(T0);
    expect((await snapshot('fresh')).scoredAt).toBe(T0 + HOUR);
  });

  it('stamps the current time by default', async () => {
    await seed([article('a1')]);
    jest.setSystemTime(T0 + 2 * HOUR);

    await batchMarkExcluded(['a1']);

    expect((await snapshot('a1')).scoredAt).toBe(T0 + 2 * HOUR);
  });

  it('tolerates a row deleted mid-flight and a call with nothing to do', async () => {
    await seed([article('a1')]);

    await expect(batchMarkExcluded(['a1', 'gone'])).resolves.toBeUndefined();
    await expect(batchMarkExcluded([])).resolves.toBeUndefined();
    await expect(batchMarkExcluded(['gone'])).resolves.toBeUndefined();

    expect((await snapshot('a1')).status).toBe('excluded');
  });
});

// MERA-APP-53/55: every row of a batch can be hard-deleted (48h sweep, clear, prune) while it is in flight.
describe('a batch whose rows were all deleted underneath it', () => {
  it('is a no-op for every marker', async () => {
    await seed([article('a1'), article('a2')]);
    await deleteSuggestionsByServerIds(['a1', 'a2']);

    await expect(batchResetToUnscored(['a1', 'a2'])).resolves.toBeUndefined();
    await expect(batchMarkReasonSkipped(['a1', 'a2'])).resolves.toBeUndefined();
    await expect(batchMarkGateSkipped(['a1', 'a2'])).resolves.toBeUndefined();
    await expect(batchMarkExcluded(['a1', 'a2'])).resolves.toBeUndefined();
    await expect(batchMarkAsScoredByIds(['a1', 'a2'])).resolves.toBeUndefined();
    await expect(batchPropagateScores([{ id: 'a1', relevance: 0.5, reason: GROUNDED }])).resolves.toBeUndefined();
  });
});

describe('batchResetToUnscored (the un-exclude direction)', () => {
  it('sends an excluded row back to unscored with every score cleared', async () => {
    await seed([article('a1')]);
    await saveScoringResult('a1', { relevance: 0.8, reason: GROUNDED, reasonSkipped: false, computedScore: 0.5, rawScore: 0.6, scoreComponentsJson: '{"mode":"math"}' });
    await toExcluded('a1');

    await batchResetToUnscored(['a1']);

    expect(await snapshot('a1')).toMatchObject({
      status: 'unscored',
      relevance: 0,
      reason: '',
      rawScore: null,
      computedScore: null,
      scoreComponentsJson: null,
      scoredAt: null,
    });
  });

  it('tolerates a row deleted mid-flight and a call with nothing to do', async () => {
    await seed([article('a1')]);
    await toExcluded('a1');

    await expect(batchResetToUnscored(['a1', 'gone'])).resolves.toBeUndefined();
    await expect(batchResetToUnscored([])).resolves.toBeUndefined();

    expect((await snapshot('a1')).status).toBe('unscored');
  });
});

describe('the two reason-skipped markers', () => {
  it('batchMarkReasonSkipped writes complete, keeping the score and writing no note', async () => {
    await seed([article('a1'), article('a2')]);
    await toReasonPending('a1', 0.3);

    await batchMarkReasonSkipped(['a1', 'a2', 'gone']);

    expect(await snapshot('a1')).toMatchObject({ status: 'complete', relevance: 0.3, reason: '' });
    expect((await snapshot('a2')).status).toBe('complete');
    await expect(batchMarkReasonSkipped([])).resolves.toBeUndefined();
  });

  // Not `complete`: a gated row is ABOVE the render gate and would show with a blank note.
  it('batchMarkGateSkipped writes reason_skipped and KEEPS the real relevance', async () => {
    await seed([article('a1')]);
    await toReasonPending('a1', 0.8);

    await batchMarkGateSkipped(['a1', 'gone']);

    expect(await snapshot('a1')).toMatchObject({ status: 'reason_skipped', relevance: 0.8, reason: '' });
    await expect(batchMarkGateSkipped([])).resolves.toBeUndefined();
  });
});

describe('batchPropagateScores', () => {
  it('copies the donor verdict and completes the row when a note came with it', async () => {
    await seed([article('a1'), article('a2')]);

    await batchPropagateScores([
      { id: 'a1', relevance: 0.72, reason: GROUNDED },
      { id: 'a2', relevance: 0.72, reason: GROUNDED },
    ]);

    for (const id of ['a1', 'a2']) {
      expect(await snapshot(id)).toMatchObject({ status: 'complete', relevance: 0.72, reason: GROUNDED });
    }
  });

  // An EMPTY copy means the donor had nothing to donate. Stamping `complete` produced a visible,
  // note-less row the sweep (reason_pending only) can never reach.
  it('leaves reason_pending when the donated note is empty or only whitespace', async () => {
    await seed([article('a1'), article('a2')]);

    await batchPropagateScores([
      { id: 'a1', relevance: 0.72, reason: '' },
      { id: 'a2', relevance: 0.72, reason: '   \n ' },
    ]);

    for (const id of ['a1', 'a2']) {
      expect(await snapshot(id)).toMatchObject({ status: 'reason_pending', relevance: 0.72, reason: '' });
    }
  });

  it('never clears a note the row already had: reason-presence is monotonic', async () => {
    await seed([article('a1')]);
    await toComplete('a1', 0.6, 'Its own harbour note.');

    await batchPropagateScores([{ id: 'a1', relevance: 0.72, reason: '' }]);

    expect(await snapshot('a1')).toMatchObject({ reason: 'Its own harbour note.', relevance: 0.72, status: 'reason_pending' });
  });

  it('trims the donated note', async () => {
    await seed([article('a1')]);

    await batchPropagateScores([{ id: 'a1', relevance: 0.72, reason: `  ${GROUNDED}  ` }]);

    expect((await snapshot('a1')).reason).toBe(GROUNDED);
  });

  it('copies a donor sentence that fits the recipient', async () => {
    await seed([article('a1')]);

    await batchPropagateScores([{ id: 'a1', relevance: 0.72, reason: GROUNDED }]);

    expect(await snapshot('a1')).toMatchObject({ reason: GROUNDED, status: 'complete' });
  });

  it('applies the entries whose row is still there when another was deleted mid-flight', async () => {
    await seed([article('a1')]);

    await expect(
      batchPropagateScores([
        { id: 'a1', relevance: 0.72, reason: GROUNDED },
        { id: 'gone', relevance: 0.72, reason: GROUNDED },
      ]),
    ).resolves.toBeUndefined();
    await expect(batchPropagateScores([])).resolves.toBeUndefined();
    await expect(batchPropagateScores([{ id: 'gone', relevance: 0.5, reason: 'x' }])).resolves.toBeUndefined();

    expect((await snapshot('a1')).status).toBe('complete');
  });
});

// A row's gate is chosen by the scorer that produced ITS score, so the vintage travels per row.
// A global flip would silently and permanently delete quantised v1 scores.
describe('the scorer vintage is a property of each row', () => {
  it('two rows inheriting different vintages in one propagation keep their own', async () => {
    await seed([article('v3'), article('legacy'), article('unstamped')]);

    await batchPropagateScores([
      { id: 'v3', relevance: 0.7, reason: GROUNDED, scoredWithV3: true },
      { id: 'legacy', relevance: 0.7, reason: GROUNDED, scoredWithV3: false },
      { id: 'unstamped', relevance: 0.7, reason: GROUNDED },
    ]);

    expect((await snapshot('v3')).scoredWithV3).toBe(true);
    expect((await snapshot('legacy')).scoredWithV3).toBe(false);
    // a pre-v50 donor carries no flag: the recipient reads as the legacy vintage
    expect((await snapshot('unstamped')).scoredWithV3).toBeNull();
  });

  it('a score written by this scorer re-stamps only its own row', async () => {
    await seed([article('v3'), article('other')]);
    await withVintage('v3', 0.7, true);
    await withVintage('other', 0.7, true);

    await saveScoringResult('v3', { relevance: 0.7, reason: GROUNDED, reasonSkipped: false });

    expect((await snapshot('v3')).scoredWithV3).toBe(false);
    expect((await snapshot('other')).scoredWithV3).toBe(true);
  });

  it('a reset leaves every vintage as it was, and the next score re-stamps it', async () => {
    await seed([article('a1'), article('a2')]);
    await withVintage('a1', 0.7, true);
    await withVintage('a2', 0.7, null);
    await batchMarkExcluded(['a1']);

    await batchResetToUnscored(['a1']);

    expect((await snapshot('a1')).scoredWithV3).toBe(true);
    expect((await snapshot('a2')).scoredWithV3).toBeNull();
    await saveScoringResult('a1', { relevance: 0.5, reason: GROUNDED, reasonSkipped: false });
    expect((await snapshot('a1')).scoredWithV3).toBe(false);
  });
});
