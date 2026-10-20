// onemera S1: card tools in the thread. Everything goes through the deriver,
// never a render (a rendering change tested on a hardcoded input passed a
// whole wave once).

import type { ConversationMessage, ToolCallRecord } from '@/lib/llm/types';
import { deriveThreadItems } from '@/components/custom/floating-chat/deriveThreadItems';
import { labelForToolCall, MUTATING_TOOLS } from '@/components/custom/floating-chat/agent-step-labels';
import type { ChatThreadItem } from '@/components/custom/floating-chat/types';

type Box = Extract<ChatThreadItem, { kind: 'agent-steps' }>;
type Applied = Extract<ChatThreadItem, { kind: 'applied-by-typing' }>;

const derive = (live: ConversationMessage[], turnActive = false) =>
  deriveThreadItems({
    live,
    history: [],
    introMessage: null,
    isStreaming: false,
    earlierConversationLabel: 'Earlier',
    turnActive,
  });
const boxes = (items: ChatThreadItem[]) => items.filter((i): i is Box => i.kind === 'agent-steps');
const applied = (items: ChatThreadItem[]) => items.filter((i): i is Applied => i.kind === 'applied-by-typing');

const user = (id: string, content = 'yes'): ConversationMessage => ({ id, role: 'user', content });
const asst = (id: string, toolCalls: ToolCallRecord[], content = 'Done.'): ConversationMessage => ({
  id,
  role: 'assistant',
  content,
  toolCalls,
});
const call = (name: string, result: Record<string, unknown>, input: unknown = {}): ToolCallRecord => ({
  id: `tc-${name}`,
  name,
  input,
  status: 'done',
  result,
});

describe('labels for the card tools', () => {
  it.each([
    ['proposeChanges', 'agentSteps.proposeChanges'],
    ['applyProposal', 'agentSteps.applyProposal'],
    ['cancelProposal', 'agentSteps.cancelProposal'],
    ['proposeTrack', 'agentSteps.proposeTrack'],
    ['proposeFactCheck', 'agentSteps.proposeFactCheck'],
    ['searchNews', 'agentSteps.searchNews'],
  ])('%s -> %s', (tool, key) => {
    expect(labelForToolCall(tool, {}).labelKey).toBe(key);
  });

  it('maps the real skill ids and none of the dead ones', () => {
    const phrase = (id: string) => labelForToolCall('load_skill', { id }).labelValues?.topicKey;
    expect(phrase('facts/profession')).toBe('skillPhrase.work');
    expect(phrase('facts/interest')).toBe('skillPhrase.interests');
    expect(phrase('conversation/feed-tuning')).toBe('skillPhrase.feedTuning');
    // Skill ids that never existed under lib/mera-harness/skills fall back too.
    for (const dead of ['facts/work', 'facts/interests', 'facts/new', 'topics/generate', 'conversation/follow-story', 'conversation/fact-check']) {
      expect(labelForToolCall('load_skill', { id: dead })).toEqual({ labelKey: 'agentSteps.loadSkillGeneric' });
    }
  });

  it('counts applyProposal as a mutating tool', () => {
    expect(MUTATING_TOOLS.has('applyProposal')).toBe(true);
  });
});

describe('offers and the refused card', () => {
  const settled = (calls: ToolCallRecord[]) => [user('u1', 'tune my feed'), asst('a1', calls)];

  it.each(['proposeChanges', 'proposeTrack', 'proposeFactCheck'])(
    'a %s result with no error is an offer, so the no-proposal terminal is dropped',
    (name) => {
      const items = deriveThreadItems({
        live: settled([call(name, { awaiting: 'user' })]),
        history: [],
        introMessage: null,
        isStreaming: false,
        earlierConversationLabel: 'Earlier',
        turnActive: false,
        agentTerminal: 'no-proposal',
      });
      expect(boxes(items)[0]?.terminal ?? null).toBeNull();
    },
  );

  it('a proposeChanges result with an error is not an offer', () => {
    const items = deriveThreadItems({
      live: settled([call('proposeChanges', { error: 'no such filter' })]),
      history: [],
      introMessage: null,
      isStreaming: false,
      earlierConversationLabel: 'Earlier',
      turnActive: false,
      agentTerminal: 'no-proposal',
    });
    expect(boxes(items)[0].terminal).toBe('no-proposal');
  });

  it('a refused card is one failure line in the box, no card, and no error text leaks', () => {
    const items = derive(
      settled([
        call('proposeChanges', { error: 'secret provider text' }),
        call('proposeChanges', { error: 'secret provider text' }),
      ]),
    );
    const [box] = boxes(items);
    const failed = box.steps.filter((s) => s.status === 'error');
    expect(failed).toHaveLength(1);
    expect(failed[0].consequenceKey).toBe('agentSteps.cardRefused');
    expect(box.failedCount).toBe(1);
    expect(items.some((i) => i.kind === 'proposal-card')).toBe(false);
    expect(JSON.stringify(box)).not.toContain('secret provider text');
  });
});

describe('applied by typing', () => {
  const ok = call('applyProposal', { applied: 2, changeLogIds: ['c1', 'c2'] });

  it('derives one row with the change-log ids, undoable while it is the latest turn', () => {
    const items = derive([user('u1'), asst('a1', [ok])]);
    expect(applied(items)).toEqual([
      expect.objectContaining({ changeLogIds: ['c1', 'c2'], undoable: true }),
    ]);
  });

  it('loses Undo once a later user message exists, and keeps the row', () => {
    const items = derive([user('u1'), asst('a1', [ok]), user('u2', 'thanks')]);
    expect(applied(items)).toHaveLength(1);
    expect(applied(items)[0].undoable).toBe(false);
  });

  it('draws nothing when nothing applied or there is nothing to undo', () => {
    expect(applied(derive([user('u1'), asst('a1', [call('applyProposal', { applied: 0, changeLogIds: ['c1'] })])]))).toEqual([]);
    expect(applied(derive([user('u1'), asst('a1', [call('applyProposal', { applied: 1, changeLogIds: [] })])]))).toEqual([]);
    expect(applied(derive([user('u1'), asst('a1', [call('applyProposal', { error: 'nope' })])]))).toEqual([]);
  });

  it('is never undoable from an earlier conversation', () => {
    const items = deriveThreadItems({
      live: [],
      history: [
        { id: 'h1', conversationId: 'old', role: 'assistant', content: 'ok', createdAt: 1, toolCalls: [ok] },
      ],
      introMessage: null,
      isStreaming: false,
      earlierConversationLabel: 'Earlier',
    });
    expect(applied(items)[0].undoable).toBe(false);
  });

  it('keeps the turn box (applyProposal changed data)', () => {
    const items = derive([user('u1'), asst('a1', [ok])]);
    expect(boxes(items)[0].changedData).toBe(true);
  });
});
