// The key->text tables of the steps box, tested pure (no render): each new
// key must resolve to its OWN text, never fall through to "Working on it".
import {
  labelForToolCall,
  stepLabel,
  stepTables,
  stepsForMessage,
} from '@/components/custom/floating-chat/agent-step-labels';

// Echoes the key, so a wrong or missing table entry is visible in the output.
const fakeT = ((key: string, opts?: Record<string, unknown>) =>
  opts?.returnObjects ? [`[${key}]`] : `[${key}]${opts?.topic ? `(${opts.topic})` : ''}`) as never;

const tables = stepTables(fakeT);
const textOf = (tool: string, input: unknown = {}) => {
  const { labelKey, labelValues } = labelForToolCall(tool, input);
  return stepLabel(
    { id: 'x', kind: 'tool', glyph: 'working', toolName: tool, labelKey, labelValues, status: 'done' },
    fakeT,
    tables,
  );
};

describe('steps box tables', () => {
  it.each([
    'proposeChanges',
    'applyProposal',
    'cancelProposal',
    'proposeTrack',
    'proposeFactCheck',
    'searchNews',
  ])('%s resolves to its own text', (tool) => {
    expect(textOf(tool)).toBe(`[agentSteps.${tool}]`);
    expect(textOf(tool)).not.toBe(textOf('some_unmapped_tool'));
  });

  it.each([
    ['facts/profession', 'skillPhrase.work'],
    ['facts/interest', 'skillPhrase.interests'],
    ['conversation/feed-tuning', 'skillPhrase.feedTuning'],
  ])('load_skill %s shows %s, not the generic line', (id, phrase) => {
    expect(textOf('load_skill', { id })).toBe(`[agentSteps.loadSkill]([${phrase}])`);
  });

  it('a refused card shows its own consequence, not the generic one', () => {
    const [step] = stepsForMessage('m1', [
      { name: 'proposeChanges', input: {}, status: 'done', result: { error: 'x' } },
    ], false);
    expect(step.consequenceKey).toBe('agentSteps.cardRefused');
    expect(tables.CONSEQUENCE[step.consequenceKey!]).toBe('[agentSteps.cardRefused]');
  });

  it('the dead skill phrases are gone from the table', () => {
    for (const dead of ['skillPhrase.newFact', 'skillPhrase.topics', 'skillPhrase.followStory', 'skillPhrase.factCheck']) {
      expect(tables.SKILL_PHRASE[dead]).toBeUndefined();
    }
  });

  it('a retry in a tool turn shows the retry words on the trailing row', () => {
    expect(tables.PLAIN_LABEL['chatPhases.retrying']).toBe('[chatPhases.retrying]');
  });
});
