// persona-mutation-sweeps: the ONE policy for "does this persona mutation need a retroactive feed sweep,
// and which one?" (D12). The decision functions are pure but the module only loads under the integration
// setup; runSweepFor is exercised against real article_suggestions rows, the real sweep and real stores.
// Replaces the mocked persona-mutation-sweeps suite.
import { batchMarkExcluded } from '@/lib/database/services/article-suggestion-service';
import {
  runSweepFor,
  sweepForMutation,
  sweepForRevert,
  type SweepDecisionInput,
} from '@/lib/database/services/persona-mutation-sweeps';
import { addSuppression } from '@/lib/database/services/suppression-service';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import {
  failTableQuery,
  quietLogger,
  resetPersonaMemory,
  restoreFaults,
  seedArticles,
  seedFeedOrder,
  settleWrites,
  statuses,
} from './support';

const A = ACTION_NAMES;

/** Every mutation shape the policy is expected to have an opinion about. */
const CASES: { name: string; input: SweepDecisionInput; forward: 'purge' | 'unexclude' | null }[] = [
  { name: 'hard add_suppression', input: { actionType: A.ADD_SUPPRESSION, hardFilter: true }, forward: 'purge' },
  { name: 'soft add_suppression', input: { actionType: A.ADD_SUPPRESSION, hardFilter: false }, forward: null },
  { name: 'hard retire_suppression', input: { actionType: A.RETIRE_SUPPRESSION, hardFilter: true }, forward: 'unexclude' },
  { name: 'soft retire_suppression', input: { actionType: A.RETIRE_SUPPRESSION, hardFilter: false }, forward: null },
  { name: 'pref none → mute', input: { actionType: A.SET_PUBLICATION_PREF, prefBefore: 'none', prefAfter: 'mute' }, forward: 'purge' },
  { name: 'pref boost → mute', input: { actionType: A.SET_PUBLICATION_PREF, prefBefore: 'boost', prefAfter: 'mute' }, forward: 'purge' },
  { name: 'pref mute → boost', input: { actionType: A.SET_PUBLICATION_PREF, prefBefore: 'mute', prefAfter: 'boost' }, forward: 'unexclude' },
  { name: 'pref mute → none', input: { actionType: A.SET_PUBLICATION_PREF, prefBefore: 'mute', prefAfter: 'none' }, forward: 'unexclude' },
  { name: 'pref boost → deprioritize (never touches mute)', input: { actionType: A.SET_PUBLICATION_PREF, prefBefore: 'boost', prefAfter: 'deprioritize' }, forward: null },
  { name: 'pref mute → mute (no boundary crossed)', input: { actionType: A.SET_PUBLICATION_PREF, prefBefore: 'mute', prefAfter: 'mute' }, forward: null },
  { name: 'scope pref none → mute (inert today, wired the same)', input: { actionType: A.SET_SOURCE_SCOPE_PREF, prefBefore: 'none', prefAfter: 'mute' }, forward: 'purge' },
  { name: 'scope pref mute → boost', input: { actionType: A.SET_SOURCE_SCOPE_PREF, prefBefore: 'mute', prefAfter: 'boost' }, forward: 'unexclude' },
  { name: 'scope pref none → boost', input: { actionType: A.SET_SOURCE_SCOPE_PREF, prefBefore: 'none', prefAfter: 'boost' }, forward: null },
  { name: 'a topic weight change', input: { actionType: A.SET_TOPIC_WEIGHT }, forward: null },
];
const mirror = (s: 'purge' | 'unexclude' | null) => (s === 'purge' ? 'unexclude' : s === 'unexclude' ? 'purge' : null);

describe('sweepForMutation', () => {
  it.each(CASES)('$name → $forward', ({ input, forward }) => {
    expect(sweepForMutation(input)).toBe(forward);
  });

  it('returns null for an unknown action type instead of throwing', () => {
    expect(sweepForMutation({ actionType: 'some_future_action', hardFilter: true, prefAfter: 'mute' })).toBeNull();
  });

  it('treats a missing hardFilter as soft and a missing pref as no boundary', () => {
    expect(sweepForMutation({ actionType: A.ADD_SUPPRESSION })).toBeNull();
    expect(sweepForMutation({ actionType: A.RETIRE_SUPPRESSION })).toBeNull();
    expect(sweepForMutation({ actionType: A.SET_PUBLICATION_PREF })).toBeNull();
  });
});

describe('sweepForRevert: the mirror invariant', () => {
  it.each(CASES)('$name inverts', ({ input, forward }) => {
    expect(sweepForRevert(input)).toBe(mirror(forward));
  });

  it('reverting a revert is the original sweep again (involution)', () => {
    for (const { input } of CASES) {
      expect(mirror(sweepForRevert(input))).toBe(sweepForMutation(input));
    }
  });
});

// ---------------------------------------------------------------------------
// runSweepFor, against real rows
// ---------------------------------------------------------------------------

describe('runSweepFor', () => {
  let logs: ReturnType<typeof quietLogger>;
  beforeEach(async () => {
    logs = quietLogger();
    resetPersonaMemory();
    await seedArticles([
      { id: 'a', title: 'Nvidia ships a GPU' },
      { id: 'b', title: 'AMD ships a GPU' },
    ]);
    seedFeedOrder(['a', 'b']);
  });
  afterEach(async () => {
    restoreFaults();
    await settleWrites();
    logs.restore();
  });
  const addNvidiaFilter = () => addSuppression({ pattern: 'nvidia', keywords: ['nvidia'], strength: 1, source: 'user' });

  it('a null sweep runs nothing and reports not-reconciled, even with a matching hard filter in force', async () => {
    await addNvidiaFilter();

    await expect(runSweepFor(null, 'x')).resolves.toBe(false);

    expect(await statuses()).toEqual({ a: 'unscored', b: 'unscored' });
    expect(useFeedOrderStore.getState().order).toEqual(['a', 'b']);
  });

  it('a successful purge excludes the matches, evicts them from the feed, refreshes the store and reports reconciled', async () => {
    await addNvidiaFilter();

    await expect(runSweepFor('purge', 'add_suppression')).resolves.toBe(true);

    expect(await statuses()).toEqual({ a: 'excluded', b: 'unscored' });
    expect(useFeedOrderStore.getState().order).toEqual(['b']);
    expect(useForYouStore.getState().suggestions.find((s) => s._id === 'a')?.status).toBe('excluded');
  });

  it('a purge with nothing to purge still counts as reconciled', async () => {
    await expect(runSweepFor('purge', 'x')).resolves.toBe(true);

    expect(await statuses()).toEqual({ a: 'unscored', b: 'unscored' });
  });

  it('an un-exclude releases rows nothing blocks any more, and reports NOT reconciled (they need a rescore)', async () => {
    await batchMarkExcluded(['a']);

    await expect(runSweepFor('unexclude', 'x')).resolves.toBe(false);

    expect(await statuses()).toEqual({ a: 'unscored', b: 'unscored' });
  });

  it('an un-exclude keeps a row excluded while another active filter still blocks it', async () => {
    await addNvidiaFilter();
    await batchMarkExcluded(['a', 'b']);

    await runSweepFor('unexclude', 'x');

    expect(await statuses()).toEqual({ a: 'excluded', b: 'unscored' });
  });

  it('a FAILED purge is swallowed, captured with its tags, and reports not-reconciled', async () => {
    await addNvidiaFilter();
    failTableQuery('article_suggestions');

    await expect(runSweepFor('purge', 'add_suppression')).resolves.toBe(false);

    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'persona-mutation-sweeps', sweep: 'purge', action_type: 'add_suppression' },
    });
  });

  it('a FAILED un-exclude is swallowed and captured too', async () => {
    failTableQuery('article_suggestions');

    await expect(runSweepFor('unexclude', 'retire_suppression')).resolves.toBe(false);

    expect(logs.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'persona-mutation-sweeps', sweep: 'unexclude', action_type: 'retire_suppression' },
    });
  });
});
