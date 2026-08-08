// publication-pref-ui-actions unit tests (item 9, Wave B). Every underlying
// service is mocked so this suite verifies ROUTING and POLICY, not the
// services themselves (those have their own suites):
//   - concrete-kind writes ('prioritised'/'deprioritised') go through
//     `applyPersonaAction` with the right action shape — the executor itself
//     owns the change-log row, the sweep and the D18 dirty-flag, so nothing
//     else should happen here for those two levels.
//   - 'none' (clear) has no executor action, so this module hand-appends the
//     change-log row and — for a NAMED PUBLICATION only — runs the same sweep
//     policy the executor would have. A country SCOPE clear never sweeps
//     (scopes can never be muted), it only dirties the feed.
//
// The "nine before→after transitions" (before ∈ {none, prioritised,
// deprioritised} × requested level ∈ {none, prioritised, deprioritised}) are
// exercised against the PUBLICATION target: the 6 transitions landing on a
// concrete kind route through `applyPersonaAction` (mocked — its internal
// sweep is not re-observed here, exactly the executor's own contract), and
// the 3 landing on 'none' hand-append + call `sweepForMutation`/`runSweepFor`/
// `markFeedNeedsRefresh` directly, which ARE observed here. The country-scope
// target gets a smaller, separate set: routing, alpha-2→alpha-3 conversion
// (plus its failure mode), label plumbing, and the no-sweep-just-refresh
// clear policy.

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn() },
}));

const mockApplyPersonaAction = jest.fn(async (..._a: unknown[]) => ({ applied: true, summary: 'ok' }));
jest.mock('../persona-action-executor', () => ({
  applyPersonaAction: (...a: unknown[]) => mockApplyPersonaAction(...a),
}));

const mockGetPreferenceKind = jest.fn(async (..._a: unknown[]) => 'none');
const mockSetPreferenceKind = jest.fn(async (..._a: unknown[]) => {});
const mockGetScopePreferenceKind = jest.fn(async (..._a: unknown[]) => 'none');
const mockSetScopePreferenceKind = jest.fn(async (..._a: unknown[]) => {});
jest.mock('../publication-preference-service', () => ({
  getPreferenceKind: (...a: unknown[]) => mockGetPreferenceKind(...a),
  setPreferenceKind: (...a: unknown[]) => mockSetPreferenceKind(...a),
  getScopePreferenceKind: (...a: unknown[]) => mockGetScopePreferenceKind(...a),
  setScopePreferenceKind: (...a: unknown[]) => mockSetScopePreferenceKind(...a),
}));

const mockAppend = jest.fn(async (..._a: unknown[]) => ({ id: 'log1' }));
jest.mock('../persona-change-log-service', () => ({
  append: (...a: unknown[]) => mockAppend(...a),
}));

const mockMarkFeedNeedsRefresh = jest.fn((..._a: unknown[]) => {});
const mockRunSweepFor = jest.fn(async (..._a: unknown[]) => false);
const mockSweepForMutation = jest.fn((..._a: unknown[]) => null as 'purge' | 'unexclude' | null);
jest.mock('../persona-mutation-sweeps', () => ({
  markFeedNeedsRefresh: (...a: unknown[]) => mockMarkFeedNeedsRefresh(...a),
  runSweepFor: (...a: unknown[]) => mockRunSweepFor(...a),
  sweepForMutation: (...a: unknown[]) => mockSweepForMutation(...a),
}));

import { setSourcePrefFromUi } from '../publication-pref-ui-actions';

beforeEach(() => {
  jest.clearAllMocks();
  mockApplyPersonaAction.mockResolvedValue({ applied: true, summary: 'ok' });
  mockGetPreferenceKind.mockResolvedValue('none');
  mockGetScopePreferenceKind.mockResolvedValue('none');
  mockRunSweepFor.mockResolvedValue(false);
  mockSweepForMutation.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// Publication target — the nine before→after transitions
// ---------------------------------------------------------------------------

describe('publication target — concrete-kind levels (6 of the 9 transitions)', () => {
  const BEFORE_STATES: ('none' | 'boost' | 'deprioritize')[] = ['none', 'boost', 'deprioritize'];

  it.each(BEFORE_STATES)('prioritised: routes through applyPersonaAction with SET_PUBLICATION_PREF/boost (before=%s)', async (before) => {
    mockGetPreferenceKind.mockResolvedValue(before);
    const result = await setSourcePrefFromUi({ kind: 'publication', publicationName: 'The Times' }, 'prioritised');
    expect(mockApplyPersonaAction).toHaveBeenCalledWith(
      {
        action_type: 'set_publication_pref',
        publicationId: 'The Times',
        publicationPref: 'boost',
      },
      'user',
    );
    // The executor owns before-reading, the change-log row and the sweep —
    // none of this module's own hand-append machinery should fire.
    expect(mockSetPreferenceKind).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
    expect(mockSweepForMutation).not.toHaveBeenCalled();
    expect(result).toEqual({ applied: true });
  });

  it.each(BEFORE_STATES)('deprioritised: routes through applyPersonaAction with SET_PUBLICATION_PREF/deprioritize (before=%s)', async (before) => {
    mockGetPreferenceKind.mockResolvedValue(before);
    const result = await setSourcePrefFromUi({ kind: 'publication', publicationName: 'The Times' }, 'deprioritised');
    expect(mockApplyPersonaAction).toHaveBeenCalledWith(
      {
        action_type: 'set_publication_pref',
        publicationId: 'The Times',
        publicationPref: 'deprioritize',
      },
      'user',
    );
    expect(mockSetPreferenceKind).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
    expect(result).toEqual({ applied: true });
  });

  it('surfaces applied:false when the executor skips/fails, without throwing', async () => {
    mockApplyPersonaAction.mockResolvedValue({ applied: false, summary: 'skipped' });
    const result = await setSourcePrefFromUi({ kind: 'publication', publicationName: 'The Times' }, 'prioritised');
    expect(result).toEqual({ applied: false });
  });
});

describe('publication target — clear / "none" (the remaining 3 of the 9 transitions)', () => {
  const CASES: {
    before: 'none' | 'boost' | 'deprioritize' | 'mute';
    sweep: 'purge' | 'unexclude' | null;
  }[] = [
    { before: 'none', sweep: null },
    { before: 'boost', sweep: null },
    { before: 'deprioritize', sweep: null },
    // A muted→none transition is the one case with a real sweep verdict —
    // included here too since it is the whole reason the sweep dance exists.
    { before: 'mute', sweep: 'unexclude' },
    // 'purge' can never actually come back for a `prefAfter: 'none'` call in
    // production (only landing ON mute purges) — included anyway so this
    // module's generic `if (!purged) markFeedNeedsRefresh()` branch is
    // exercised for BOTH outcomes, not just the one this call site can reach
    // today; `sweepForMutation` is mocked here precisely so this module's own
    // handling of its contract is what's under test, not the real policy.
    { before: 'boost', sweep: 'purge' },
  ];

  it.each(CASES)(
    'before=$before: hand-appends the change-log row and asks sweepForMutation for the right verdict',
    async ({ before, sweep }) => {
      mockGetPreferenceKind.mockResolvedValue(before);
      mockSweepForMutation.mockReturnValue(sweep);
      mockRunSweepFor.mockResolvedValue(sweep === 'purge'); // mirrors runSweepFor's real contract

      const result = await setSourcePrefFromUi({ kind: 'publication', publicationName: 'The Times' }, 'none');

      expect(mockApplyPersonaAction).not.toHaveBeenCalled();
      expect(mockSetPreferenceKind).toHaveBeenCalledWith('The Times', 'none', 'user');
      expect(mockAppend).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: 'set_publication_pref',
          action: { targetId: 'The Times', before, after: 'none' },
        }),
      );
      expect(mockSweepForMutation).toHaveBeenCalledWith({
        actionType: 'set_publication_pref',
        prefBefore: before,
        prefAfter: 'none',
      });
      expect(mockRunSweepFor).toHaveBeenCalledWith(sweep, 'set_publication_pref');
      // markFeedNeedsRefresh fires whenever the sweep did NOT already purge —
      // i.e. every case here except a successful purge.
      if (sweep === 'purge') {
        expect(mockMarkFeedNeedsRefresh).not.toHaveBeenCalled();
      } else {
        expect(mockMarkFeedNeedsRefresh).toHaveBeenCalledTimes(1);
      }
      expect(result).toEqual({ applied: true });
    },
  );
});

// ---------------------------------------------------------------------------
// Country-scope target — routing, alpha-2→alpha-3 conversion, label, no-sweep clear
// ---------------------------------------------------------------------------

describe('country-scope target', () => {
  it('prioritised: converts alpha-2 → alpha-3 and routes through applyPersonaAction with SET_SOURCE_SCOPE_PREF', async () => {
    const result = await setSourcePrefFromUi(
      { kind: 'country', countryAlpha2: 'IN', label: 'India' },
      'prioritised',
    );
    expect(mockApplyPersonaAction).toHaveBeenCalledWith(
      {
        action_type: 'set_source_scope_pref',
        scopeKind: 'country',
        scopeValue: 'IND',
        scopeLabel: 'India',
        publicationPref: 'boost',
      },
      'user',
    );
    expect(result).toEqual({ applied: true });
  });

  it('deprioritised: same conversion, publicationPref "deprioritize"', async () => {
    await setSourcePrefFromUi({ kind: 'country', countryAlpha2: 'in', label: 'India' }, 'deprioritised');
    expect(mockApplyPersonaAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action_type: 'set_source_scope_pref',
        scopeValue: 'IND',
        publicationPref: 'deprioritize',
      }),
      'user',
    );
  });

  it('an unmappable alpha-2 code fails closed: applied:false, nothing written', async () => {
    const result = await setSourcePrefFromUi(
      { kind: 'country', countryAlpha2: 'ZZ', label: 'Nowhere' },
      'prioritised',
    );
    expect(result).toEqual({ applied: false });
    expect(mockApplyPersonaAction).not.toHaveBeenCalled();
  });

  it('none: hand-appends with the scope-composite targetId, converts alpha-2→alpha-3, and never sweeps — just refreshes', async () => {
    mockGetScopePreferenceKind.mockResolvedValue('boost');
    const result = await setSourcePrefFromUi({ kind: 'country', countryAlpha2: 'IN', label: 'India' }, 'none');

    expect(mockApplyPersonaAction).not.toHaveBeenCalled();
    expect(mockSetScopePreferenceKind).toHaveBeenCalledWith(
      { scopeKind: 'country', scopeValue: 'IND' },
      'none',
      'India',
      'user',
    );
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'set_source_scope_pref',
        action: { targetId: 'country:IND', before: 'boost', after: 'none' },
      }),
    );
    // Scopes can never be muted (the executor rejects it, stage-scoring never
    // derives a hard filter from one) — clearing one never consults the sweep
    // policy, unlike the named-publication clear above.
    expect(mockSweepForMutation).not.toHaveBeenCalled();
    expect(mockRunSweepFor).not.toHaveBeenCalled();
    expect(mockMarkFeedNeedsRefresh).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ applied: true });
  });

  it('none with an unmappable alpha-2 code also fails closed, without touching the store', async () => {
    const result = await setSourcePrefFromUi({ kind: 'country', countryAlpha2: 'ZZ', label: 'Nowhere' }, 'none');
    expect(result).toEqual({ applied: false });
    expect(mockSetScopePreferenceKind).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
  });
});
