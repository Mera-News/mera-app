// Pure label mapping. No renderer, no store.

import {
  changedDataFrom,
  consequenceKeyFor,
  GENERIC_CONSEQUENCE_KEY,
  GENERIC_LABEL_KEY,
  INTERRUPTED_CONSEQUENCE_KEY,
  labelArg,
  labelForToolCall,
  legStartStep,
  MAX_LABEL_ARG,
  stepsForMessage,
} from '../agent-step-labels';

describe('labelForToolCall', () => {
  // The argument FIELD NAMES are the thing review caught: an earlier draft read
  // `skill`/`name` and `place`. Each case below feeds the real field.
  it('reads load_skill from `id` and renders a phrase key, never the id', () => {
    const out = labelForToolCall('load_skill', { id: 'facts/residence' });
    expect(out).toEqual({
      labelKey: 'agentSteps.loadSkill',
      labelValues: { topicKey: 'skillPhrase.residence' },
    });
    expect(JSON.stringify(out)).not.toContain('facts/residence');
  });

  it('falls back to a generic sentence for an UNMAPPED skill id, leaking nothing', () => {
    const out = labelForToolCall('load_skill', { id: 'facts/not-mapped-yet' });
    expect(out).toEqual({ labelKey: 'agentSteps.loadSkillGeneric' });
    expect(JSON.stringify(out)).not.toContain('not-mapped-yet');
  });

  it('reads lookup_place from `query`', () => {
    expect(labelForToolCall('lookup_place', { query: 'Nieuw-West' })).toEqual({
      labelKey: 'agentSteps.lookupPlace',
      labelValues: { query: 'Nieuw-West' },
    });
  });

  it('ignores the field names an earlier draft assumed', () => {
    // `skill` / `place` must NOT satisfy these tools.
    expect(labelForToolCall('load_skill', { skill: 'facts/residence' })).toEqual({
      labelKey: 'agentSteps.loadSkillGeneric',
    });
    expect(labelForToolCall('lookup_place', { place: 'Nieuw-West' })).toEqual({
      labelKey: GENERIC_LABEL_KEY,
    });
  });

  it('maps the argument-free tools', () => {
    expect(labelForToolCall('find_similar_facts', {}).labelKey).toBe(
      'agentSteps.findSimilarFacts',
    );
    expect(labelForToolCall('saveExtractedFacts', {}).labelKey).toBe('agentSteps.writeUp');
    expect(labelForToolCall('deleteUserFacts', {}).labelKey).toBe('agentSteps.removing');
  });

  it('falls back for an unknown tool rather than dropping the row', () => {
    expect(labelForToolCall('some_future_tool', { a: 1 })).toEqual({
      labelKey: GENERIC_LABEL_KEY,
    });
  });

  it('caps a long argument and tolerates a missing or non-string one', () => {
    const long = 'x'.repeat(MAX_LABEL_ARG + 20);
    expect(labelForToolCall('lookup_place', { query: long }).labelValues?.query).toHaveLength(
      MAX_LABEL_ARG,
    );
    expect(labelForToolCall('lookup_place', {}).labelKey).toBe(GENERIC_LABEL_KEY);
    expect(labelForToolCall('lookup_place', { query: 42 }).labelKey).toBe(GENERIC_LABEL_KEY);
    expect(labelForToolCall('lookup_place', null).labelKey).toBe(GENERIC_LABEL_KEY);
  });

  it('trims and caps via labelArg', () => {
    expect(labelArg('  hi  ')).toBe('hi');
    expect(labelArg('   ')).toBe('');
    expect(labelArg(undefined)).toBe('');
  });
});

describe('consequenceKeyFor', () => {
  it('names what the failure cost, per tool', () => {
    expect(consequenceKeyFor('lookup_place', false)).toBe('agentSteps.consequence.lookupPlace');
    expect(consequenceKeyFor('load_skill', false)).toBe('agentSteps.consequence.loadSkill');
  });

  it('falls back generically for an unknown tool', () => {
    expect(consequenceKeyFor('mystery', false)).toBe(GENERIC_CONSEQUENCE_KEY);
    expect(consequenceKeyFor(undefined, false)).toBe(GENERIC_CONSEQUENCE_KEY);
  });

  it('an interrupted step says it was interrupted, whatever the tool', () => {
    expect(consequenceKeyFor('lookup_place', true)).toBe(INTERRUPTED_CONSEQUENCE_KEY);
    expect(consequenceKeyFor(undefined, true)).toBe(INTERRUPTED_CONSEQUENCE_KEY);
  });
});

describe('stepsForMessage', () => {
  const calls = [
    { name: 'find_similar_facts', input: {}, status: 'done' as const },
    { name: 'lookup_place', input: { query: 'Nieuw-West' }, status: 'pending' as const },
  ];

  it('keys each row by messageId::index, never by tool-call id', () => {
    expect(stepsForMessage('m1', calls, false).map((s) => s.id)).toEqual(['m1::0', 'm1::1']);
  });

  it('carries status through untouched when the turn is live', () => {
    expect(stepsForMessage('m1', calls, false).map((s) => s.status)).toEqual([
      'done',
      'pending',
    ]);
  });

  it('strands pending rows as errors ONLY when the turn is interrupted', () => {
    const out = stepsForMessage('m1', calls, true);
    expect(out.map((s) => s.status)).toEqual(['done', 'error']);
    expect(out[1].consequenceKey).toBe(INTERRUPTED_CONSEQUENCE_KEY);
    // A row that had already settled keeps its own outcome.
    expect(out[0].consequenceKey).toBeUndefined();
  });

  it('gives an errored row a consequence, so no row ever shows a bare failure', () => {
    const out = stepsForMessage('m1', [{ name: 'lookup_place', input: {}, status: 'error' }], false);
    expect(out[0].consequenceKey).toBe('agentSteps.consequence.lookupPlace');
  });

  it('emits nothing for a message with no tool calls', () => {
    expect(stepsForMessage('m1', undefined, false)).toEqual([]);
    expect(stepsForMessage('m1', [], false)).toEqual([]);
  });
});

describe('legStartStep and changedDataFrom', () => {
  it('opens a leg pending and settles it', () => {
    expect(legStartStep('m1', false)).toMatchObject({ id: 'm1::leg', status: 'pending' });
    expect(legStartStep('m1', true).status).toBe('done');
  });

  it('counts a staged save as data-changing and a pure lookup as not', () => {
    expect(changedDataFrom(stepsForMessage('m', [{ name: 'saveExtractedFacts', input: {}, status: 'done' }], false))).toBe(true);
    expect(changedDataFrom(stepsForMessage('m', [{ name: 'deleteUserFacts', input: {}, status: 'done' }], false))).toBe(true);
    expect(changedDataFrom(stepsForMessage('m', [{ name: 'lookup_place', input: {}, status: 'done' }], false))).toBe(false);
    expect(changedDataFrom([legStartStep('m', true)])).toBe(false);
  });
});
