// P9 regression: score propagation must not smuggle a hard-"Blocked" article into the feed.
//
// `batchPropagateScores` copies a scored donor's relevance onto its unscored story siblings and
// marks them terminal. Those rows never enter the scoring stage, the ONLY place the hard screen
// runs during scoring, so a newly-synced article that an active hard filter blocks could inherit a
// passing (> 0.3) score from a sibling and render while the UI badges the filter "Blocked".
//
// Real story grouping, real propagation, real shared matcher (`purgeHardFilteredByIds`), real rows.
import { propagateToUnscoredSiblings } from '@/lib/feed-grouping/score-propagation';
import { __resetSuggestionsRefreshThrottleForTests } from '@/lib/services/SuggestionSyncService';
import { purgeHardFilteredByIds } from '@/lib/services/suppression-sweep';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import {
  addHardFilter,
  failAllReads,
  quietLogger,
  resetForYouStore,
  scoreRow,
  seedArticles,
  settleWrites,
  suggestionRows,
} from './seed';

/** Rows sharing clusterId `c1` at high confidence form ONE story group: the edge a score crosses. */
const story = (rows: { id: string; title: string; publication?: string }[]) =>
  seedArticles(rows.map((r) => ({ ...r, clusterId: 'c1' })));

/** A donor already scored 0.9 (well above the 0.3 render gate). */
async function seedDonor() {
  await story([{ id: 'donor', title: 'Chip story donor' }]);
  await scoreRow('donor', 0.9);
}

let logs: ReturnType<typeof quietLogger>;
beforeEach(() => {
  logs = quietLogger();
  __resetSuggestionsRefreshThrottleForTests();
  resetForYouStore();
  useFeedOrderStore.setState({ hydrated: false, order: [], itemsById: {}, builtAt: null });
});
afterEach(async () => {
  await settleWrites();
  __resetSuggestionsRefreshThrottleForTests();
  logs.restore();
});

describe('score propagation x hard filters (P9)', () => {
  it('does NOT leave a hard-filtered article renderable after it inherits a passing donor score', async () => {
    await seedDonor();
    await story([
      { id: 'blocked', title: 'Nvidia ships a GPU' },
      { id: 'ok', title: 'AMD ships a GPU' },
    ]);
    await addHardFilter({ keyword: 'nvidia' });

    const propagated = await propagateToUnscoredSiblings(new Set(), purgeHardFilteredByIds);

    // Precondition of the bug: both siblings DID inherit the donor's 0.9 and were written without
    // ever meeting the hard screen. The fix: exactly those ids get re-screened and the blocked one
    // is made terminal `excluded` so it cannot render; the sibling nothing matches keeps its score.
    expect(propagated).toBe(2);
    const rows = await suggestionRows();
    expect(rows.blocked).toMatchObject({ status: 'excluded', relevance: 0 });
    expect(rows.ok).toMatchObject({ relevance: 0.9 });
    expect(rows.ok.status).not.toBe('excluded');
    expect(rows.donor).toMatchObject({ status: 'complete', relevance: 0.9 });
  });

  it('evicts the blocked id from the persisted Feed order it had already been laid out in', async () => {
    useFeedOrderStore.setState({
      hydrated: true,
      order: ['blocked', 'ok'],
      itemsById: { blocked: { id: 'blocked' } as never, ok: { id: 'ok' } as never },
    });
    await seedDonor();
    await story([
      { id: 'blocked', title: 'First sibling', publication: 'The Verge' },
      { id: 'ok', title: 'Second sibling', publication: 'Other' },
    ]);
    await addHardFilter({ kind: 'publication', value: 'the verge' });

    await propagateToUnscoredSiblings(new Set(), purgeHardFilteredByIds);

    expect(useFeedOrderStore.getState().order).toEqual(['ok']);
    // The store was refreshed: the on-screen row shows the exclusion.
    expect(useForYouStore.getState().suggestions.find((s) => s._id === 'blocked')?.status).toBe('excluded');
  });

  it('costs nothing when the user has no hard filters (propagation stands, nothing excluded)', async () => {
    await seedDonor();
    await story([
      { id: 'a', title: 'First sibling' },
      { id: 'b', title: 'Second sibling' },
    ]);

    const propagated = await propagateToUnscoredSiblings(new Set(), purgeHardFilteredByIds);

    expect(propagated).toBe(2);
    const rows = await suggestionRows();
    expect(rows.a.relevance).toBe(0.9);
    expect(rows.b.relevance).toBe(0.9);
    expect(Object.values(rows).map((r) => r.status)).not.toContain('excluded');
  });

  it('a reconcile failure never fails the propagation (already committed)', async () => {
    await seedDonor();
    await story([{ id: 'a', title: 'First sibling' }]);
    // The persona snapshot cannot be loaded, so the reconcile throws.
    const restore = failAllReads('persona_suppressions', new Error('persona unavailable'));

    try {
      await expect(propagateToUnscoredSiblings(new Set(), purgeHardFilteredByIds)).resolves.toBe(1);
    } finally {
      restore();
    }
    expect((await suggestionRows()).a.relevance).toBe(0.9);
  });
});
