// ux1 audit regressions in the thread deriver. Each failed before ux1.

import type { ConversationMessage, ToolCallRecord } from '@/lib/llm/types';
import { deriveThreadItems } from '../deriveThreadItems';
import type { ChatThreadItem } from '../types';

type Box = Extract<ChatThreadItem, { kind: 'agent-steps' }>;

function base(
  overrides: Partial<Parameters<typeof deriveThreadItems>[0]> = {},
): Parameters<typeof deriveThreadItems>[0] {
  return {
    live: [],
    history: [],
    introMessage: null,
    isStreaming: false,
    earlierConversationLabel: 'Earlier conversation',
    ...overrides,
  };
}

const user = (id: string, content = 'hi'): ConversationMessage => ({ id, role: 'user', content });
const asst = (id: string, content: string, toolCalls?: ToolCallRecord[]): ConversationMessage => ({
  id, role: 'assistant', content, toolCalls,
});
const call = (name: string, input: Record<string, unknown> = {}, status: ToolCallRecord['status'] = 'done'): ToolCallRecord => ({
  id: `tc-${name}-${Math.random()}`, name, input, status,
});
const boxes = (items: ChatThreadItem[]): Box[] =>
  items.filter((i): i is Box => i.kind === 'agent-steps');

describe('F5: a new turn never reopens the previous box', () => {
  it('keeps the earlier box collapsed while the new turn has no tools yet', () => {
    const items = deriveThreadItems(base({
      live: [
        user('u1'),
        asst('a1', 'Done.', [call('find_similar_facts')]),
        user('u2'),
      ],
      isStreaming: true,
      turnActive: true,
    }));
    // Either dropped (a read-only turn keeps no box) or collapsed, and never
    // carrying the live "Working on it" row.
    const all = boxes(items);
    expect(all.every((b) => b.collapsed)).toBe(true);
    expect(all.some((b) => b.steps.some((st) => st.labelKey === 'agentSteps.working'))).toBe(false);
  });

  it('stamps the terminal on the last turn only, even when it had no tools', () => {
    const items = deriveThreadItems(base({
      live: [
        user('u1'),
        asst('a1', 'Done.', [call('find_similar_facts')]),
        user('u2'),
        asst('a2', ''),
      ],
      turnActive: false,
      agentTerminal: 'no-route',
    }));
    const all = boxes(items);
    expect(all.find((b) => b.key === 'agent-steps-u1')?.terminal ?? null).toBeNull();
    expect(all.find((b) => b.key === 'agent-steps-u2')?.terminal).toBe('no-route');
  });
});

describe('F6: one row for a repeated step', () => {
  it('merges three consecutive find_similar_facts into one row', () => {
    const items = deriveThreadItems(base({
      live: [
        user('u1'),
        asst('a1', 'ok', [
          call('find_similar_facts', { kind: 'interest' }),
          call('find_similar_facts', { kind: 'generic' }),
          call('find_similar_facts', {}),
        ]),
      ],
      turnActive: true,
    }));
    const [box] = boxes(items);
    const rows = box.steps.filter((s) => s.labelKey === 'agentSteps.findSimilarFacts');
    expect(rows).toHaveLength(1);
  });

  it('a merged row carries the worst status among its repeats', () => {
    const items = deriveThreadItems(base({
      live: [
        user('u1'),
        asst('a1', 'ok', [call('find_similar_facts'), call('find_similar_facts', {}, 'error')]),
      ],
      turnActive: false,
    }));
    const [box] = boxes(items);
    expect(box.steps.filter((s) => s.labelKey === 'agentSteps.findSimilarFacts').map((s) => s.status)).toEqual(['error']);
  });
});

describe('B14: the chip question stays visible beside other text', () => {
  const ask = (content: string) =>
    deriveThreadItems(base({
      live: [
        user('u1'),
        asst('a1', content, [call('ask_choice', { question: 'Which Berlin?', options: ['Berlin, Germany', 'Berlin, USA'] })]),
      ],
    })).find((i) => i.kind === 'ask-choice-card') as Extract<ChatThreadItem, { kind: 'ask-choice-card' }>;

  it('shows the question when the bubble is only an acknowledgement', () => {
    expect(ask('Berlin, one moment.').question).toBe('Which Berlin?');
  });

  it('hides it when the bubble already asks it', () => {
    expect(ask('Got it. Which Berlin?').question).toBeNull();
  });
});

describe('F34: a proposal card follows its own instruction', () => {
  it('moves the card after the reply that came back from its tool', () => {
    const track = call('proposeTrack', {
      options: ['Berlin-Hamburg Flixtrain service', 'Flixtrain fleet expansion'],
    });
    const items = deriveThreadItems(base({
      live: [
        user('u1', 'I want to follow this story.'),
        asst('a1', '', [track]),
        asst('a2', 'Pick the story you want to follow below.'),
        user('u2', 'thanks'),
      ],
    }));
    const kinds = items.map((i) => (i.kind === 'message' ? `${i.message.role}:${i.message.id}` : i.kind));
    const cardAt = kinds.indexOf('proposal-card');
    if (cardAt === -1) {
      // The fixture must actually produce a card, or this test proves nothing.
      throw new Error(`no proposal card derived: ${kinds.join(',')}`);
    }
    expect(cardAt).toBeGreaterThan(kinds.indexOf('assistant:a2'));
    expect(cardAt).toBeLessThan(kinds.indexOf('user:u2'));
  });
});
