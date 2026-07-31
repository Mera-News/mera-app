// The shared sweep policy (D12) — the single predicate both the executor seam
// and revertChange consult.
//
// The property that matters most is the MIRROR INVARIANT: undoing a mutation
// must need exactly the opposite sweep. That is the whole reason the two
// mutation paths cannot drift apart again, so it is asserted directly rather
// than only through the per-case examples.

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

import {
  runSweepFor,
  sweepForMutation,
  sweepForRevert,
  type SweepDecisionInput,
} from '../persona-mutation-sweeps';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import * as sweep from '@/lib/services/suppression-sweep';

const purge = sweep.purgeHardFilteredSuggestions as jest.Mock;
const unexclude = sweep.unexcludeRetiredHardFilters as jest.Mock;

beforeEach(() => jest.clearAllMocks());

/** Every mutation shape the policy is expected to have an opinion about. */
const CASES: { name: string; input: SweepDecisionInput; forward: string | null }[] = [
  {
    name: 'hard add_suppression',
    input: { actionType: ACTION_NAMES.ADD_SUPPRESSION, hardFilter: true },
    forward: 'purge',
  },
  {
    name: 'soft add_suppression',
    input: { actionType: ACTION_NAMES.ADD_SUPPRESSION, hardFilter: false },
    forward: null,
  },
  {
    name: 'hard retire_suppression',
    input: { actionType: ACTION_NAMES.RETIRE_SUPPRESSION, hardFilter: true },
    forward: 'unexclude',
  },
  {
    name: 'soft retire_suppression',
    input: { actionType: ACTION_NAMES.RETIRE_SUPPRESSION, hardFilter: false },
    forward: null,
  },
  {
    name: 'pref none → mute',
    input: { actionType: ACTION_NAMES.SET_PUBLICATION_PREF, prefBefore: 'none', prefAfter: 'mute' },
    forward: 'purge',
  },
  {
    name: 'pref mute → boost',
    input: { actionType: ACTION_NAMES.SET_PUBLICATION_PREF, prefBefore: 'mute', prefAfter: 'boost' },
    forward: 'unexclude',
  },
  {
    name: 'pref boost → deprioritize (never touches mute)',
    input: {
      actionType: ACTION_NAMES.SET_PUBLICATION_PREF,
      prefBefore: 'boost',
      prefAfter: 'deprioritize',
    },
    forward: null,
  },
  {
    name: 'pref mute → mute (no boundary crossed)',
    input: { actionType: ACTION_NAMES.SET_PUBLICATION_PREF, prefBefore: 'mute', prefAfter: 'mute' },
    forward: null,
  },
  {
    name: 'a topic weight change',
    input: { actionType: ACTION_NAMES.SET_TOPIC_WEIGHT },
    forward: null,
  },
];

describe('sweepForMutation', () => {
  it.each(CASES)('$name → $forward', ({ input, forward }) => {
    expect(sweepForMutation(input)).toBe(forward);
  });

  it('returns null for an unknown action type instead of throwing', () => {
    expect(sweepForMutation({ actionType: 'some_future_action' })).toBeNull();
  });

  it('treats a missing hardFilter as soft', () => {
    expect(sweepForMutation({ actionType: ACTION_NAMES.ADD_SUPPRESSION })).toBeNull();
  });
});

describe('sweepForRevert — the mirror invariant', () => {
  it.each(CASES)('$name inverts', ({ input, forward }) => {
    const expected =
      forward === 'purge' ? 'unexclude' : forward === 'unexclude' ? 'purge' : null;
    expect(sweepForRevert(input)).toBe(expected);
  });

  it('reverting a revert is the original sweep again (involution)', () => {
    for (const { input } of CASES) {
      const once = sweepForRevert(input);
      const twice = once === 'purge' ? 'unexclude' : once === 'unexclude' ? 'purge' : null;
      expect(twice).toBe(sweepForMutation(input));
    }
  });

  it('undoing a hard add releases, undoing a hard removal re-purges', () => {
    // The two cases the D12c bug was actually about, spelled out.
    expect(sweepForRevert({ actionType: ACTION_NAMES.ADD_SUPPRESSION, hardFilter: true })).toBe(
      'unexclude',
    );
    expect(
      sweepForRevert({ actionType: ACTION_NAMES.RETIRE_SUPPRESSION, hardFilter: true }),
    ).toBe('purge');
  });

  it('undoing a mute releases; undoing an unmute re-purges', () => {
    expect(
      sweepForRevert({
        actionType: ACTION_NAMES.SET_PUBLICATION_PREF,
        prefBefore: 'none',
        prefAfter: 'mute',
      }),
    ).toBe('unexclude');
    expect(
      sweepForRevert({
        actionType: ACTION_NAMES.SET_PUBLICATION_PREF,
        prefBefore: 'mute',
        prefAfter: 'none',
      }),
    ).toBe('purge');
  });
});

describe('runSweepFor', () => {
  it('runs nothing and reports not-reconciled for a null sweep', async () => {
    expect(await runSweepFor(null, 'x')).toBe(false);
    expect(purge).not.toHaveBeenCalled();
    expect(unexclude).not.toHaveBeenCalled();
  });

  it('a successful purge reports reconciled (caller must NOT also dirty)', async () => {
    expect(await runSweepFor('purge', 'x')).toBe(true);
    expect(purge).toHaveBeenCalledTimes(1);
  });

  it('an un-exclude reports NOT reconciled (released rows need a rescore)', async () => {
    expect(await runSweepFor('unexclude', 'x')).toBe(false);
    expect(unexclude).toHaveBeenCalledTimes(1);
  });

  it('a FAILED purge is swallowed and reports not-reconciled', async () => {
    purge.mockRejectedValueOnce(new Error('boom'));
    await expect(runSweepFor('purge', 'x')).resolves.toBe(false);
  });

  it('a FAILED un-exclude is swallowed too', async () => {
    unexclude.mockRejectedValueOnce(new Error('boom'));
    await expect(runSweepFor('unexclude', 'x')).resolves.toBe(false);
  });
});
