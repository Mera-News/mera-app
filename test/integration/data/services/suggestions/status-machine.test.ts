// The article_suggestions status machine (lib/database/article-suggestion-status.ts), driven through the
// real writers and read back through the real readers. `excluded` and `already_read` are terminal:
// they never render and no sweep brings them back. Replaces nothing on its own (the legacy suites
// pinned single transitions against a mock); it is the seam that makes the machine one thing.
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import {
  batchPropagateScores,
  batchResetToUnscored,
  loadSuggestions,
  getCullableLowHeadlineIds,
  getScoredDonorRows,
  getScoredSuggestionsWithoutReasons,
  getUnscoredGroupingRows,
  getUnscoredSuggestionsWithFacts,
  saveReason,
  saveScoringResult,
} from '@/lib/database/services/article-suggestion-service';
import {
  DAY,
  GROUNDED,
  T0,
  article,
  freezeClock,
  seed,
  statusOf,
  toAlreadyRead,
  toComplete,
  toExcluded,
  toReasonPending,
  toReasonSkipped,
} from './support';

beforeEach(() => freezeClock());

describe('ArticleSuggestionStatus', () => {
  it('is exactly the six states, as plain text (a new one needs no migration)', () => {
    expect(ArticleSuggestionStatus).toEqual({
      Unscored: 'unscored',
      ReasonPending: 'reason_pending',
      Complete: 'complete',
      Excluded: 'excluded',
      AlreadyRead: 'already_read',
      ReasonSkipped: 'reason_skipped',
    });
  });
});

describe('transitions, each through its real writer', () => {
  it('starts unscored', async () => {
    await seed([article('a1')]);
    expect(await statusOf('a1')).toBe('unscored');
  });

  it('unscored -> reason_pending -> complete (a score, then its note)', async () => {
    await seed([article('a1')]);

    await toReasonPending('a1');
    expect(await statusOf('a1')).toBe('reason_pending');
    await saveReason('a1', GROUNDED);
    expect(await statusOf('a1')).toBe('complete');
  });

  it('unscored -> complete (a score that came with its note)', async () => {
    await seed([article('a1')]);
    await toComplete('a1');
    expect(await statusOf('a1')).toBe('complete');
  });

  it('unscored -> excluded (a hard filter), and any scored status -> excluded (the retroactive purge)', async () => {
    await seed([article('fresh'), article('pending'), article('done')]);
    await toReasonPending('pending');
    await toComplete('done');

    await toExcluded('fresh');
    await toExcluded('pending');
    await toExcluded('done');

    for (const id of ['fresh', 'pending', 'done']) expect(await statusOf(id)).toBe('excluded');
  });

  it('unscored -> already_read (the story was opened before scoring)', async () => {
    await seed([article('a1')]);
    await toAlreadyRead('a1');
    expect(await statusOf('a1')).toBe('already_read');
  });

  it('reason_pending -> reason_skipped (the tag gate declined to write a note)', async () => {
    await seed([article('a1')]);
    await toReasonPending('a1');
    await toReasonSkipped('a1');
    expect(await statusOf('a1')).toBe('reason_skipped');
  });

  it('excluded -> unscored is the one documented exit, through the un-exclude sweep', async () => {
    await seed([article('a1')]);
    await toExcluded('a1');
    await batchResetToUnscored(['a1']);
    expect(await statusOf('a1')).toBe('unscored');
  });
});

// A terminal row must never render and no read hands it back to a writer. Every sweep and queue
// read is checked with one of each terminal status on the device.
describe('terminal rows stay out of every sweep and queue read', () => {
  async function seedTerminal() {
    await seed(
      ['excluded', 'read', 'skipped'].map((id) => article(id)),
      { headline: { excluded: 'GLOBAL', read: 'GLOBAL', skipped: 'GLOBAL' } },
    );
    await toComplete('skipped', 0.4);
    await toExcluded('excluded');
    await toAlreadyRead('read');
    await toReasonSkipped('skipped');
  }

  it('the orphaned-reason sweep never re-elects them', async () => {
    await seedTerminal();
    expect(await getScoredSuggestionsWithoutReasons()).toEqual([]);
  });

  it('the scoring queue never takes them', async () => {
    await seedTerminal();
    expect(await getUnscoredSuggestionsWithFacts()).toEqual([]);
    expect(await getUnscoredGroupingRows()).toEqual([]);
  });

  it('they never donate a score to a sibling', async () => {
    await seedTerminal();
    expect(await getScoredDonorRows(T0 - DAY)).toEqual([]);
  });

  it('the headline cull has nothing left to cull, so it never re-marks them', async () => {
    await seedTerminal();
    expect(await getCullableLowHeadlineIds()).toEqual([]);
  });
});

// A score or a note that lands after the row went terminal overwrites the status: none of the writers
// guards it. Reachable: a hard filter (retroactive exclude) or the already-read backfill marks a row
// while its scoring batch is in flight, then the decode calls these. The row comes back with a score
// above the gate and renders. Whether the guard belongs in the writer or in its callers is a lead
// decision; the other writers that share the shape (saveReason, which leaves relevance 0 and so only
// shifts the status, batchMarkAsScoredByIds, batchMarkReasonSkipped, batchMarkGateSkipped) are listed in
// the report, not pinned here.
describe('a terminal row is not moved back by a late score or propagated verdict', () => {
  const late: Record<string, (id: string) => Promise<void>> = {
    saveScoringResult: (id) => saveScoringResult(id, { relevance: 0.9, reason: GROUNDED, reasonSkipped: false }),
    batchPropagateScores: (id) => batchPropagateScores([{ id, relevance: 0.9, reason: GROUNDED }]),
  };
  const terminal: Record<string, (id: string) => Promise<void>> = {
    excluded: toExcluded,
    already_read: toAlreadyRead,
  };

  for (const [writer, write] of Object.entries(late)) {
    for (const [status, makeTerminal] of Object.entries(terminal)) {
      test.failing(`${writer} leaves an ${status} row ${status}`, async () => {
        await seed([article('a1')]);
        await makeTerminal('a1');

        await write('a1');

        expect(await statusOf('a1')).toBe(status);
      });

      // R14 sibling: today's outcome, deleted by the fix that flips the test above.
      test(`today: ${writer} turns an ${status} row complete with a score of 0.9`, async () => {
        await seed([article('a1')]);
        await makeTerminal('a1');

        await write('a1');

        const [s] = await loadSuggestions();
        expect(s).toMatchObject({ status: 'complete', relevance: 0.9 });
      });
    }
  }
});
