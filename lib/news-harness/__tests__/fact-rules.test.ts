// Pure accept/reject rules — reproduces the exact decisions the old
// handleSaveExtractedFacts made inline.

import {
  MAX_FACT_LENGTH,
  filterFactChoiceGroups,
  filterNewFacts,
  normalizeFactEntry,
  normalizeStatement,
} from '../persona-management/fact-rules';

describe('MAX_FACT_LENGTH', () => {
  it('is 200', () => {
    expect(MAX_FACT_LENGTH).toBe(200);
  });
});

describe('normalizeStatement', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizeStatement('  Lives   IN  Amsterdam ')).toBe('lives in amsterdam');
  });
});

describe('normalizeFactEntry', () => {
  it('wraps a plain string with no questionnaire metadata', () => {
    expect(normalizeFactEntry('Lives in Amsterdam')).toEqual({
      statement: 'Lives in Amsterdam',
    });
  });

  it('maps questionnaire fields when present', () => {
    expect(
      normalizeFactEntry({
        statement: 'Senior ML engineer',
        questionnaire_attribute: 'profession: job',
      }),
    ).toEqual({
      statement: 'Senior ML engineer',
      questionnaire: { attribute: 'profession: job' },
    });
  });

  it('leaves questionnaire undefined when no metadata fields are present', () => {
    expect(normalizeFactEntry({ statement: 'plain object fact' })).toEqual({
      statement: 'plain object fact',
      questionnaire: undefined,
    });
  });

  it('defaults an object statement to empty string when missing', () => {
    expect(normalizeFactEntry({ statement: undefined as unknown as string })).toEqual({
      statement: '',
    });
  });
});

describe('filterNewFacts', () => {
  it('accepts a valid new fact', () => {
    const { accepted, rejected } = filterNewFacts(['Lives in Amsterdam'], []);
    expect(accepted).toEqual([{ statement: 'Lives in Amsterdam', questionnaire: undefined }]);
    expect(rejected).toEqual([]);
  });

  it('rejects empty / whitespace-only statements', () => {
    const { accepted, rejected } = filterNewFacts(['', '   '], []);
    expect(accepted).toHaveLength(0);
    expect(rejected.map((r) => r.reason)).toEqual(['empty', 'empty']);
  });

  it('rejects statements longer than MAX_FACT_LENGTH', () => {
    const long = 'a'.repeat(MAX_FACT_LENGTH + 1);
    const { accepted, rejected } = filterNewFacts([long], []);
    expect(accepted).toHaveLength(0);
    expect(rejected).toEqual([{ statement: long, reason: 'too-long' }]);
  });

  it('rejects meta-conversational "User is ..." statements', () => {
    const { rejected } = filterNewFacts(['User is setting up persona'], []);
    expect(rejected).toEqual([{ statement: 'User is setting up persona', reason: 'meta' }]);
  });

  it('rejects "updating profile" meta statements', () => {
    const { rejected } = filterNewFacts(['updating profile preferences'], []);
    expect(rejected).toEqual([
      { statement: 'updating profile preferences', reason: 'meta' },
    ]);
  });

  it('rejects duplicates against existing statements (case/space insensitive)', () => {
    const { accepted, rejected } = filterNewFacts(
      ['lives in amsterdam'],
      [normalizeStatement('Lives in Amsterdam')],
    );
    expect(accepted).toHaveLength(0);
    expect(rejected).toEqual([{ statement: 'lives in amsterdam', reason: 'duplicate' }]);
  });

  // The case above pre-normalizes, so it encoded the CALLER's precondition
  // rather than the function's contract — which is exactly how the asymmetry
  // below survived: the set was keyed on the raw string and probed with a
  // normalized one, so dedup worked only for a caller that had already
  // normalized. Production had (tool-handlers), so the app was correct and the
  // function was not.
  it('dedups against RAW existing statements, with no normalization by the caller', () => {
    const { accepted, rejected } = filterNewFacts(
      ['Lives in Rotterdam, Netherlands'],
      ['Lives in Rotterdam, Netherlands'],
    );
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([
      { statement: 'Lives in Rotterdam, Netherlands', reason: 'duplicate' },
    ]);
  });

  it('dedups a RAW existing statement against a differently-cased incoming one', () => {
    const { accepted } = filterNewFacts(
      ['lives   in  ROTTERDAM, Netherlands'],
      ['Lives in Rotterdam, Netherlands'],
    );
    expect(accepted).toEqual([]);
  });

  it('is unchanged for an ALREADY-normalized caller, which is what production passes', () => {
    // normalizeStatement is idempotent, so normalizing on insert must be a no-op
    // here. If this ever fails, the fix has become a silent behaviour change in
    // the one shipped call path.
    const { accepted, rejected } = filterNewFacts(
      ['Lives in Rotterdam, Netherlands'],
      [normalizeStatement('Lives in Rotterdam, Netherlands')],
    );
    expect(accepted).toEqual([]);
    expect(rejected[0].reason).toBe('duplicate');
  });

  it('filterFactChoiceGroups inherits the same safety', () => {
    // It forwards existingStatements to filterNewFacts untouched, so it carried
    // the identical unstated precondition.
    const { groups } = filterFactChoiceGroups(
      [{ statement: 'Lives in Rotterdam, Netherlands' }],
      ['Lives in Rotterdam, Netherlands'],
    );
    expect(groups).toEqual([]);
  });

  it('does NOT dedup accepted facts against each other within one batch', () => {
    // Matches the original behaviour: existing set is the only dedup source.
    const { accepted } = filterNewFacts(['Same fact', 'Same fact'], []);
    expect(accepted).toHaveLength(2);
  });

  it('carries questionnaire metadata onto accepted entries', () => {
    const { accepted } = filterNewFacts(
      [
        {
          statement: 'Senior ML engineer',
          questionnaire_attribute: 'profession: job',
        },
      ],
      [],
    );
    expect(accepted[0].questionnaire).toEqual({
      attribute: 'profession: job',
    });
  });

  it('trims the statement it accepts', () => {
    const { accepted } = filterNewFacts(['  Lives in Berlin  '], []);
    expect(accepted[0].statement).toBe('Lives in Berlin');
  });
});
