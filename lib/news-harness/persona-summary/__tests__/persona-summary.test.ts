// Pure persona-summary pipeline tests (RN-free): prompt selection/capping,
// strict-JSON parsing (incl. malformed → throw), and draft→result assembly.

import {
  assemblePersonaSummaryStrings,
  buildPersonaSummaryPrompt,
  parsePersonaSummaryOutput,
  selectFactsForSummary,
  MAX_FACTS_IN_PROMPT,
  MAX_STATEMENT_CHARS,
  MAX_SUMMARY_STRINGS,
  type PersonaSummaryFactInput,
} from '../index';

function fact(overrides: Partial<PersonaSummaryFactInput>): PersonaSummaryFactInput {
  return {
    factId: overrides.factId ?? 'f1',
    statement: overrides.statement ?? 'Lives in Pune',
    weight: overrides.weight ?? 1,
    topicIds: overrides.topicIds ?? [],
  };
}

describe('selectFactsForSummary', () => {
  it('orders by weight desc and caps to the configured max', () => {
    const facts = Array.from({ length: MAX_FACTS_IN_PROMPT + 5 }, (_, i) =>
      fact({ factId: `f${i}`, statement: `s${i}`, weight: i }),
    );
    const selected = selectFactsForSummary(facts);
    expect(selected).toHaveLength(MAX_FACTS_IN_PROMPT);
    // Highest weight first.
    expect(selected[0].weight).toBe(facts.length - 1);
    expect(selected[selected.length - 1].weight).toBe(facts.length - MAX_FACTS_IN_PROMPT);
  });

  it('is a stable sort for equal weights (original order preserved)', () => {
    const facts = [
      fact({ factId: 'a', weight: 1 }),
      fact({ factId: 'b', weight: 1 }),
      fact({ factId: 'c', weight: 1 }),
    ];
    const selected = selectFactsForSummary(facts);
    expect(selected.map((f) => f.factId)).toEqual(['a', 'b', 'c']);
  });
});

describe('buildPersonaSummaryPrompt', () => {
  it('numbers facts 1..N and truncates long statements to the cap', () => {
    const long = 'x'.repeat(MAX_STATEMENT_CHARS + 50);
    const { system, user } = buildPersonaSummaryPrompt([
      fact({ factId: 'f1', statement: long }),
      fact({ factId: 'f2', statement: 'Follows cricket' }),
    ]);
    expect(system).toContain('JSON array');
    expect(user).toContain('1. ');
    expect(user).toContain('2. Follows cricket');
    // The truncated statement never exceeds the cap on the fact line.
    const firstLine = user.split('\n').find((l) => l.startsWith('1. '))!;
    expect(firstLine.length).toBeLessThanOrEqual(MAX_STATEMENT_CHARS + 5 /* "N. " prefix */);
  });
});

describe('parsePersonaSummaryOutput', () => {
  it('parses a clean JSON array', () => {
    const raw = '[{"text":"Lives in Pune","facts":[1]},{"text":"Follows startups","facts":[2,3]}]';
    const drafts = parsePersonaSummaryOutput(raw);
    expect(drafts).toEqual([
      { text: 'Lives in Pune', factRefs: [1] },
      { text: 'Follows startups', factRefs: [2, 3] },
    ]);
  });

  it('recovers an array wrapped in prose / code fences', () => {
    const raw = 'Sure!\n```json\n[{"text":"A","facts":[1]}]\n```\nDone';
    expect(parsePersonaSummaryOutput(raw)).toEqual([{ text: 'A', factRefs: [1] }]);
  });

  it('skips entries with blank/missing text but keeps valid ones', () => {
    const raw = '[{"text":"","facts":[1]},{"facts":[2]},{"text":"Keep","facts":[3]}]';
    expect(parsePersonaSummaryOutput(raw)).toEqual([{ text: 'Keep', factRefs: [3] }]);
  });

  it('coerces string/float fact refs and drops invalid ones', () => {
    const raw = '[{"text":"A","facts":["1", 2.0, 0, -3, "x"]}]';
    expect(parsePersonaSummaryOutput(raw)).toEqual([{ text: 'A', factRefs: [1, 2] }]);
  });

  it('defaults factRefs to [] when absent', () => {
    expect(parsePersonaSummaryOutput('[{"text":"A"}]')).toEqual([{ text: 'A', factRefs: [] }]);
  });

  it('throws on empty output', () => {
    expect(() => parsePersonaSummaryOutput('   ')).toThrow();
  });

  it('throws when there is no JSON array at all', () => {
    expect(() => parsePersonaSummaryOutput('I could not do that.')).toThrow();
  });

  it('throws on malformed JSON inside the brackets', () => {
    expect(() => parsePersonaSummaryOutput('[{"text": "A", facts: [1]}]')).toThrow();
  });
});

describe('assemblePersonaSummaryStrings', () => {
  const selected = [
    fact({ factId: 'fact-A', topicIds: ['t1', 't2'] }),
    fact({ factId: 'fact-B', topicIds: ['t2', 't3'] }),
    fact({ factId: 'fact-C', topicIds: ['t4'] }),
  ];

  it('maps 1-based refs to fact ids and unions their topic ids', () => {
    const results = assemblePersonaSummaryStrings(
      [{ text: 'Lives in Pune', factRefs: [1, 2] }],
      selected,
    );
    expect(results).toHaveLength(1);
    expect(results[0].linkedFactIds).toEqual(['fact-A', 'fact-B']);
    expect(results[0].linkedTopicIds).toEqual(['t1', 't2', 't3']); // deduped union
  });

  it('drops out-of-range refs but keeps the string (empty links allowed)', () => {
    const results = assemblePersonaSummaryStrings(
      [{ text: 'Curious about the world', factRefs: [99] }],
      selected,
    );
    expect(results[0].linkedFactIds).toEqual([]);
    expect(results[0].linkedTopicIds).toEqual([]);
  });

  it('dedupes case-insensitively and skips over-long strings', () => {
    const results = assemblePersonaSummaryStrings(
      [
        { text: 'Follows startups', factRefs: [1] },
        { text: 'follows startups', factRefs: [2] },
        { text: 'x'.repeat(200), factRefs: [3] },
      ],
      selected,
    );
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('Follows startups');
  });

  it('caps the number of strings to the max', () => {
    const drafts = Array.from({ length: MAX_SUMMARY_STRINGS + 4 }, (_, i) => ({
      text: `string ${i}`,
      factRefs: [1],
    }));
    const results = assemblePersonaSummaryStrings(drafts, selected);
    expect(results).toHaveLength(MAX_SUMMARY_STRINGS);
  });
});
