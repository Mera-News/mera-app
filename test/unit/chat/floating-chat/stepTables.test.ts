// The key->text tables of the steps box, tested pure (no render): each new
// key must resolve to its OWN text, never fall through to "Working on it".
// The tables are pure; the heavy view imports (Reanimated, the Mera mark) are
// stubbed so the module loads in the unit project.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: 'View' },
  FadeIn: { duration: () => ({}) },
  withTiming: () => 0,
}));
jest.mock('@/components/custom/chat/StatusIndicator', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/theme/tokens', () => ({
  themedStyles: () => () => ({}),
  useColors: () => ({}),
}));
jest.mock('@/components/custom/floating-chat/glyph-safe', () => ({ GlyphSafeButton: () => null }));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({ useAnimationsActive: () => true }));

import { stepLabel, stepTables } from '@/components/custom/floating-chat/AgentStepsBox';
import { labelForToolCall, stepsForMessage } from '@/components/custom/floating-chat/agent-step-labels';

// Echoes the key, so a wrong or missing table entry is visible in the output.
const fakeT = ((key: string, opts?: Record<string, unknown>) =>
  opts?.returnObjects ? [`[${key}]`] : `[${key}]${opts?.topic ? `(${opts.topic})` : ''}`) as never;

const tables = stepTables(fakeT);
const textOf = (tool: string, input: unknown = {}) => {
  const { labelKey, labelValues } = labelForToolCall(tool, input);
  return stepLabel(
    { id: 'x', kind: 'tool', toolName: tool, labelKey, labelValues, status: 'done' },
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
    ['conversation/follow-story', 'skillPhrase.followStory'],
    ['conversation/fact-check', 'skillPhrase.factCheck'],
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
    expect(tables.SKILL_PHRASE['skillPhrase.newFact']).toBeUndefined();
    expect(tables.SKILL_PHRASE['skillPhrase.topics']).toBeUndefined();
  });
});
