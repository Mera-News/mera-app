// Pure per-group fact-choice state. No store, no DB, no React.
//
// The defect this module exists to prevent: one tap on one card used to REPLACE
// the shared tool result, which deleted every sibling group's derivation input.
// The first test below is that regression, stated at the level the bug actually
// lived at.

import {
  factChoiceGroupId,
  groupIdOf,
  mergeGroupResolution,
  readGroupResolutions,
  readPendingGroups,
  unresolvedGroups,
  type FactChoiceResolution,
} from '../fact-choice-resolution';

function staged(optionSets: string[][]): Record<string, unknown> {
  return {
    success: true,
    staged: true,
    factsSaved: 0,
    savedFacts: [],
    conflicts: [],
    groupResolutions: {},
    pendingFacts: optionSets.map((options, index) => ({
      index,
      groupId: factChoiceGroupId(index, options),
      options,
      questionnaireAttribute: null,
    })),
  };
}

const savedRes = (
  statement: string,
  id = 'f1',
): Extract<FactChoiceResolution, { status: 'saved' }> => ({
  status: 'saved',
  statements: [statement],
  savedFacts: [{ id, statement }],
  conflicts: [],
});

describe('factChoiceGroupId', () => {
  it('is stable for the same index and options', () => {
    expect(factChoiceGroupId(0, ['Lives in Hoorn'])).toBe(
      factChoiceGroupId(0, ['Lives in Hoorn']),
    );
  });

  it('ignores case and surrounding whitespace', () => {
    expect(factChoiceGroupId(1, ['  Lives in Hoorn  '])).toBe(
      factChoiceGroupId(1, ['lives in hoorn']),
    );
  });

  it('differs by index and by option text', () => {
    expect(factChoiceGroupId(0, ['A'])).not.toBe(factChoiceGroupId(1, ['A']));
    expect(factChoiceGroupId(0, ['A'])).not.toBe(factChoiceGroupId(0, ['B']));
    // Two options vs one option that happens to concatenate the same letters.
    expect(factChoiceGroupId(0, ['A', 'B'])).not.toBe(factChoiceGroupId(0, ['AB']));
  });

  it('recomputes the same id a legacy group would be stamped with', () => {
    const group = { index: 2, options: ['Works as a farmer'], questionnaireAttribute: null };
    expect(groupIdOf(group)).toBe(factChoiceGroupId(2, ['Works as a farmer']));
  });
});

describe('mergeGroupResolution', () => {
  it('REGRESSION: resolving one group leaves every sibling group pending', () => {
    const result = staged([['Lives in Hoorn'], ['Works as a farmer'], ['Parents in Malaga']]);
    const groups = readPendingGroups(result);

    const next = mergeGroupResolution(result, groupIdOf(groups[1]), savedRes('Works as a farmer'));

    // The spine is untouched: all three groups still derive.
    expect(readPendingGroups(next)).toHaveLength(3);
    // Exactly one is resolved; the other two still block the composer.
    expect(unresolvedGroups(next).map((g) => g.index)).toEqual([0, 2]);
  });

  it('keeps the resolved group at its own index in the spine', () => {
    const result = staged([['A'], ['B'], ['C']]);
    const groups = readPendingGroups(result);
    const next = mergeGroupResolution(result, groupIdOf(groups[0]), savedRes('A'));
    expect(readPendingGroups(next).map((g) => g.index)).toEqual([0, 1, 2]);
  });

  it('materialises the marker on a LEGACY pending blob, then merges', () => {
    // No `groupResolutions` key at all — staged by an older bundle.
    const legacy = {
      success: true,
      staged: true,
      pendingFacts: [{ index: 0, options: ['Lives in Hoorn'], questionnaireAttribute: null }],
    };
    expect(readGroupResolutions(legacy)).toBeNull();

    const groups = readPendingGroups(legacy);
    const next = mergeGroupResolution(legacy, groupIdOf(groups[0]), savedRes('Lives in Hoorn'));
    expect(readGroupResolutions(next)).not.toBeNull();
    expect(unresolvedGroups(next)).toHaveLength(0);
  });

  it('keeps factsSaved 0 and the legacy arrays empty while PARTIALLY resolved', () => {
    const result = staged([['A'], ['B']]);
    const groups = readPendingGroups(result);
    const next = mergeGroupResolution(result, groupIdOf(groups[0]), savedRes('A'));
    // deriveCard falls back to the tool INPUT when savedFacts is absent, so a
    // partially resolved turn must not look like a completed save.
    expect(next.factsSaved).toBe(0);
    expect(next.savedFacts).toEqual([]);
    expect(next.staged).toBe(true);
  });

  it('writes the legacy fully-resolved shape once EVERY group is resolved', () => {
    const result = staged([['A'], ['B']]);
    const groups = readPendingGroups(result);
    let next = mergeGroupResolution(result, groupIdOf(groups[0]), savedRes('A', 'fa'));
    next = mergeGroupResolution(next, groupIdOf(groups[1]), savedRes('B', 'fb'));

    // An older bundle after an OTA rollback reads this as done: no pendingFacts
    // to re-offer, and the top-level shape it shipped with.
    expect(next.pendingFacts).toBeUndefined();
    expect(next.staged).toBe(false);
    expect(next.factsSaved).toBe(2);
    expect(next.savedFacts).toEqual([
      { id: 'fa', statement: 'A' },
      { id: 'fb', statement: 'B' },
    ]);
    // The new bundle keeps rendering per-group cards.
    expect(Object.keys(readGroupResolutions(next) ?? {})).toHaveLength(2);
    expect(readPendingGroups(next)).toHaveLength(2);
  });

  it('a dismissed group counts as resolved but contributes no saved fact', () => {
    const result = staged([['A'], ['B']]);
    const groups = readPendingGroups(result);
    let next = mergeGroupResolution(result, groupIdOf(groups[0]), savedRes('A', 'fa'));
    next = mergeGroupResolution(next, groupIdOf(groups[1]), {
      status: 'dismissed',
      options: ['B'],
      questionnaireAttribute: null,
    });
    expect(unresolvedGroups(next)).toHaveLength(0);
    expect(next.factsSaved).toBe(1);
    expect(next.savedFacts).toEqual([{ id: 'fa', statement: 'A' }]);
  });

  it('UNDO returns a dismissed group to pending, even after the full rewrite', () => {
    const result = staged([['A']]);
    const groups = readPendingGroups(result);
    const dismissed = mergeGroupResolution(result, groupIdOf(groups[0]), {
      status: 'dismissed',
      options: ['A'],
      questionnaireAttribute: null,
    });
    // Single group, so dismissing it already triggered the fully-resolved
    // rewrite and dropped `pendingFacts`. Undo must still find its spine.
    expect(dismissed.pendingFacts).toBeUndefined();

    const undone = mergeGroupResolution(dismissed, groupIdOf(groups[0]), undefined);
    expect(unresolvedGroups(undone).map((g) => g.index)).toEqual([0]);
    expect(undone.staged).toBe(true);
  });

  it('preserves per-group conflicts on the group that raised them', () => {
    const result = staged([['A'], ['B']]);
    const groups = readPendingGroups(result);
    const conflict = {
      newFactId: 'n1',
      newStatement: 'B',
      existingFactId: 'e1',
      existingStatement: 'B old',
      kind: 'contradiction' as const,
      suggestedMerge: 'B',
    };
    const next = mergeGroupResolution(result, groupIdOf(groups[1]), {
      status: 'saved',
      statements: ['B'],
      savedFacts: [{ id: 'n1', statement: 'B' }],
      conflicts: [conflict],
    });
    const stored = readGroupResolutions(next)?.[groupIdOf(groups[1])];
    expect(stored).toMatchObject({ status: 'saved', conflicts: [conflict] });
  });

  it('round-trips the batch marker that decides merged vs in-line topics', () => {
    const result = staged([['A']]);
    const groups = readPendingGroups(result);
    const next = mergeGroupResolution(result, groupIdOf(groups[0]), {
      ...savedRes('A'),
      batch: true,
    });
    expect(readGroupResolutions(next)?.[groupIdOf(groups[0])]).toMatchObject({ batch: true });
  });
});

describe('readGroupResolutions', () => {
  it('returns null for a legacy blob and a record for a group-shaped one', () => {
    expect(readGroupResolutions({ savedFacts: [] })).toBeNull();
    expect(readGroupResolutions({ groupResolutions: {} })).toEqual({});
  });

  it('drops a malformed entry rather than rendering an unanswerable card', () => {
    const parsed = readGroupResolutions({
      groupResolutions: { a: { status: 'nonsense' }, b: null, c: { status: 'dismissed' } },
    });
    expect(Object.keys(parsed ?? {})).toEqual(['c']);
  });
});

describe('unresolvedGroups', () => {
  it('is empty for a legacy blob, which has no group state to be unresolved', () => {
    expect(
      unresolvedGroups({ pendingFacts: [{ index: 0, options: ['A'] }] }),
    ).toEqual([]);
  });
});
