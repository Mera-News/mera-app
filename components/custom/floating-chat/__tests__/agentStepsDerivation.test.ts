// The per-turn agent-steps box: turn keying, collapse, and the interrupted
// predicate. The predicate is the part that has already been wrong once, so
// most of this file is about which flag it keys on.

import type { ConversationMessage, ToolCallRecord } from '@/lib/llm/types';
import { deriveThreadItems } from '../deriveThreadItems';
import type { ChatThreadItem, PersistedMessage } from '../types';

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

const user = (id: string): ConversationMessage => ({ id, role: 'user', content: 'hi' });

const tool = (name: string, status: ToolCallRecord['status']): ToolCallRecord => ({
  id: `tc-${name}`,
  name,
  input: name === 'lookup_place' ? { query: 'Nieuw-West' } : {},
  status,
});

const asst = (
  id: string,
  content: string,
  toolCalls?: ToolCallRecord[],
): ConversationMessage => ({ id, role: 'assistant', content, toolCalls });

const persisted = (
  id: string,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  createdAt: number,
  toolCalls: ToolCallRecord[] | null = null,
): PersistedMessage => ({ id, conversationId, role, content, createdAt, toolCalls });

const boxes = (items: ChatThreadItem[]): Box[] =>
  items.filter((i): i is Box => i.kind === 'agent-steps');

describe('the box exists at all', () => {
  it('renders for a CONTENT-LESS assistant message whose calls are pending', () => {
    // Before this, `deriveCard` returned null for a pending call, the message
    // had no cards, and the "empty assistant message" guard dropped the whole
    // thing — which is why the thread was silent during tool execution.
    const items = deriveThreadItems(
      base({
        live: [user('u1'), asst('a1', '', [tool('lookup_place', 'pending')])],
        isStreaming: true,
        turnActive: true,
      }),
    );
    expect(boxes(items)).toHaveLength(1);
    expect(boxes(items)[0].steps.some((s) => s.status === 'pending')).toBe(true);
  });

  it('emits NOTHING extra for a turn with no tool calls', () => {
    const items = deriveThreadItems(
      base({ live: [user('u1'), asst('a1', 'just chatting')] }),
    );
    expect(boxes(items)).toHaveLength(0);
  });
});

describe('one box per TURN, not per message', () => {
  it('accumulates two legs into a single box keyed to the turn', () => {
    const items = deriveThreadItems(
      base({
        live: [
          user('u1'),
          asst('a1', '', [tool('find_similar_facts', 'done')]),
          asst('a2', 'here you go', [tool('saveExtractedFacts', 'done')]),
        ],
      }),
    );
    const found = boxes(items);
    expect(found).toHaveLength(1);
    expect(found[0].key).toBe('agent-steps-u1');
    // leg-start + both legs' tools.
    expect(found[0].steps.map((s) => s.toolName)).toEqual([
      undefined,
      'find_similar_facts',
      'saveExtractedFacts',
    ]);
  });

  it('starts a new box at the next user message', () => {
    const items = deriveThreadItems(
      base({
        live: [
          user('u1'),
          asst('a1', 'one', [tool('saveExtractedFacts', 'done')]),
          user('u2'),
          asst('a2', 'two', [tool('deleteUserFacts', 'done')]),
        ],
      }),
    );
    expect(boxes(items).map((b) => b.key)).toEqual([
      'agent-steps-u1',
      'agent-steps-u2',
    ]);
  });

  it('anchors the box after the user message, above the assistant prose', () => {
    const items = deriveThreadItems(
      base({
        live: [user('u1'), asst('a1', 'preamble', [tool('lookup_place', 'done')])],
      }),
    );
    const order = items.map((i) => i.kind);
    expect(order.indexOf('agent-steps')).toBeLessThan(order.lastIndexOf('message'));
  });
});

describe('the interrupted predicate keys on turnActive, never on streaming', () => {
  const liveTurn = [user('u1'), asst('a1', '', [tool('lookup_place', 'pending')])];

  it('BETWEEN LEGS: turn active, stream closed, pending stays PENDING', () => {
    // The regression this predicate exists to prevent. The stream for this leg
    // has ended and a device tool is running; the turn has NOT ended.
    const items = deriveThreadItems(
      base({ live: liveTurn, isStreaming: false, turnActive: true }),
    );
    const box = boxes(items)[0];
    expect(box.interrupted).toBe(false);
    expect(box.collapsed).toBe(false);
    expect(box.steps.some((s) => s.status === 'pending')).toBe(true);
  });

  it('a finished turn with stranded pending calls IS interrupted', () => {
    const items = deriveThreadItems(
      base({ live: liveTurn, isStreaming: false, turnActive: false }),
    );
    const box = boxes(items)[0];
    expect(box.interrupted).toBe(true);
    expect(box.collapsed).toBe(true);
    // No row may still be pending, or the spinner never stops.
    expect(box.steps.every((s) => s.status !== 'pending')).toBe(true);
    expect(box.steps.find((s) => s.toolName === 'lookup_place')).toMatchObject({
      status: 'error',
      consequenceKey: 'agentSteps.consequence.interrupted',
    });
  });

  it('isStreaming CANNOT rescue a dead turn, and CANNOT kill a live one', () => {
    // Behavioural proof that the wrong flag is not consulted, in both
    // directions — stronger than grepping the source for an identifier.
    const dead = boxes(
      deriveThreadItems(base({ live: liveTurn, isStreaming: true, turnActive: false })),
    )[0];
    expect(dead.interrupted).toBe(true);

    const alive = boxes(
      deriveThreadItems(base({ live: liveTurn, isStreaming: false, turnActive: true })),
    )[0];
    expect(alive.interrupted).toBe(false);
  });

  it('falls back safely when turnActive is unwired: nothing live is interrupted', () => {
    const box = boxes(
      deriveThreadItems(base({ live: liveTurn, isStreaming: true })),
    )[0];
    expect(box.interrupted).toBe(false);
  });

  it('a STALE turn is interrupted even while another turn is active', () => {
    const items = deriveThreadItems(
      base({
        history: [
          persisted('h-u', 'conv-old', 'user', 'hi', 1),
          persisted('h-a', 'conv-old', 'assistant', '', 2, [
            tool('lookup_place', 'pending'),
          ]),
        ],
        live: [user('u1'), asst('a1', '', [tool('find_similar_facts', 'pending')])],
        turnActive: true,
      }),
    );
    const staleBox = boxes(items).find((b) => b.key === 'agent-steps-h-u');
    const liveBox = boxes(items).find((b) => b.key === 'agent-steps-u1');
    expect(staleBox?.interrupted).toBe(true);
    expect(liveBox?.interrupted).toBe(false);
  });

  it('a RESUMED current-conversation turn follows turnActive, not the key prefix', () => {
    // Resumed messages are emitted with the 'hist' prefix but are NOT stale.
    // Keying on the prefix would mark the live turn's own resumed legs dead.
    const resume = [
      persisted('r-u', 'conv-now', 'user', 'hi', 1),
      persisted('r-a', 'conv-now', 'assistant', '', 2, [tool('lookup_place', 'pending')]),
    ];
    const active = boxes(
      deriveThreadItems(base({ resume, turnActive: true })),
    )[0];
    expect(active.interrupted).toBe(false);

    const ended = boxes(
      deriveThreadItems(base({ resume, turnActive: false })),
    )[0];
    expect(ended.interrupted).toBe(true);
  });
});

describe('collapse, and what survives in scroll-back', () => {
  it('stays expanded while the turn runs and collapses once at turn end', () => {
    const live = [user('u1'), asst('a1', '', [tool('saveExtractedFacts', 'pending')])];
    expect(boxes(deriveThreadItems(base({ live, turnActive: true })))[0].collapsed).toBe(
      false,
    );

    const done = [user('u1'), asst('a1', 'ok', [tool('saveExtractedFacts', 'done')])];
    expect(boxes(deriveThreadItems(base({ live: done, turnActive: false })))[0].collapsed).toBe(
      true,
    );
  });

  it('keeps a settled box for a turn that changed data', () => {
    const items = deriveThreadItems(
      base({ live: [user('u1'), asst('a1', 'ok', [tool('saveExtractedFacts', 'done')])] }),
    );
    expect(boxes(items)).toHaveLength(1);
    expect(boxes(items)[0].changedData).toBe(true);
  });

  it('SUPPRESSES a settled box for a pure-read turn', () => {
    const items = deriveThreadItems(
      base({ live: [user('u1'), asst('a1', 'ok', [tool('lookup_place', 'done')])] }),
    );
    expect(boxes(items)).toHaveLength(0);
  });

  it('keeps a settled pure-read box when something FAILED', () => {
    const items = deriveThreadItems(
      base({ live: [user('u1'), asst('a1', 'ok', [tool('lookup_place', 'error')])] }),
    );
    expect(boxes(items)).toHaveLength(1);
    expect(boxes(items)[0].failedCount).toBe(1);
  });
});

describe('exactly one liveness signal', () => {
  it('suppresses the typing item WHILE a steps box is pending', () => {
    const items = deriveThreadItems(
      base({
        live: [user('u1'), asst('a1', '', [tool('lookup_place', 'pending')])],
        isStreaming: true,
        turnActive: true,
      }),
    );
    // Asserted together: a bug that drops BOTH would pass "no typing" alone.
    expect(boxes(items)).toHaveLength(1);
    expect(items.some((i) => i.kind === 'typing')).toBe(false);
  });

  it('still shows typing before any tool call exists', () => {
    const items = deriveThreadItems(
      base({ live: [user('u1')], isStreaming: true, turnActive: true }),
    );
    expect(items.some((i) => i.kind === 'typing')).toBe(true);
  });
});
