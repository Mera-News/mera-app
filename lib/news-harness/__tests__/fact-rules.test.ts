// Pure accept/reject rules — reproduces the exact decisions the old
// handleSaveExtractedFacts made inline.

import {
  MAX_FACT_LENGTH,
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
        questionnaire_level: 1,
        questionnaire_level_category: 'Core',
        questionnaire_attribute: 'profession: job',
      }),
    ).toEqual({
      statement: 'Senior ML engineer',
      questionnaire: { level: 1, levelCategory: 'Core', attribute: 'profession: job' },
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
          questionnaire_level: 1,
          questionnaire_level_category: 'Core',
          questionnaire_attribute: 'profession: job',
        },
      ],
      [],
    );
    expect(accepted[0].questionnaire).toEqual({
      level: 1,
      levelCategory: 'Core',
      attribute: 'profession: job',
    });
  });

  it('trims the statement it accepts', () => {
    const { accepted } = filterNewFacts(['  Lives in Berlin  '], []);
    expect(accepted[0].statement).toBe('Lives in Berlin');
  });
});
