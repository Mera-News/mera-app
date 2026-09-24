// Where the ask_choice card comes from, and when it is spent.

import type { ConversationMessage, ToolCallRecord } from '@/lib/llm/types';
import { deriveThreadItems } from '../deriveThreadItems';
import type { ChatThreadItem } from '../types';

type Ask = Extract<ChatThreadItem, { kind: 'ask-choice-card' }>;

const base = (o: Partial<Parameters<typeof deriveThreadItems>[0]> = {}) => ({
  live: [],
  history: [],
  introMessage: null,
  isStreaming: false,
  earlierConversationLabel: 'Earlier',
  ...o,
});

const askCall = (options: string[] = ['The district', 'The club']): ToolCallRecord => ({
  id: 'tc1',
  name: 'ask_choice',
  input: { question: 'Which one?', options },
  status: 'done',
});

const asst = (id: string, content: string, tc?: ToolCallRecord[]): ConversationMessage => ({
  id,
  role: 'assistant',
  content,
  toolCalls: tc,
});
const user = (id: string): ConversationMessage => ({ id, role: 'user', content: 'hi' });

const asks = (items: ChatThreadItem[]) =>
  items.filter((i): i is Ask => i.kind === 'ask-choice-card');

describe('deriving the chips', () => {
  it('emits the options from the tool input', () => {
    const items = deriveThreadItems(base({ live: [user('u1'), asst('a1', '', [askCall()])] }));
    expect(asks(items)).toHaveLength(1);
    expect(asks(items)[0].options).toEqual(['The district', 'The club']);
  });

  it('renders the question only when the bubble has none', () => {
    const silent = deriveThreadItems(base({ live: [user('u1'), asst('a1', '', [askCall()])] }));
    expect(asks(silent)[0].question).toBe('Which one?');

    // The model commonly writes the question as prose AND calls the tool.
    const spoken = deriveThreadItems(
      base({ live: [user('u1'), asst('a1', 'Which one?', [askCall()])] }),
    );
    expect(asks(spoken)[0].question).toBeNull();
  });

  it('caps at 3 options and ignores a degenerate 1-option call', () => {
    const four = deriveThreadItems(
      base({ live: [user('u1'), asst('a1', '', [askCall(['a', 'b', 'c', 'd'])])] }),
    );
    expect(asks(four)[0].options).toEqual(['a', 'b', 'c']);

    const one = deriveThreadItems(
      base({ live: [user('u1'), asst('a1', '', [askCall(['only'])])] }),
    );
    expect(asks(one)).toHaveLength(0);
  });
});

describe('when the offer is spent', () => {
  it('is live while it is the newest turn', () => {
    const items = deriveThreadItems(base({ live: [user('u1'), asst('a1', '', [askCall()])] }));
    expect(asks(items)[0].answered).toBe(false);
  });

  it('is answered once ANY later user message exists', () => {
    // Tapped, or typed past: both move the conversation on.
    const items = deriveThreadItems(
      base({ live: [user('u1'), asst('a1', '', [askCall()]), user('u2')] }),
    );
    expect(asks(items)[0].answered).toBe(true);
  });

  it('is always answered in an earlier conversation', () => {
    const items = deriveThreadItems(
      base({
        history: [
          { id: 'h1', conversationId: 'old', role: 'assistant', content: '', createdAt: 1, toolCalls: [askCall()] },
        ],
      }),
    );
    expect(asks(items)[0].answered).toBe(true);
  });
});

// Owner rule (ux1): a chip list of distinct facts always carries "Save all".
// The device case: "I live in niew West Amsterdam and I'm an expat from india".
describe('Save all on a chip list of distinct facts', () => {
  const FACTS = ['You are an expat', 'You are from India', 'You live in New West, Amsterdam'];

  it('carries the exact text a Save all tap sends', () => {
    const items = deriveThreadItems(base({ live: [user('u1'), asst('a1', '', [askCall(FACTS)])] }));
    expect(asks(items)[0].saveAll).toBe('You are an expat. You are from India. You live in New West, Amsterdam.');
  });

  it('covers every option, even past the chips shown', () => {
    const four = [...FACTS, 'You work at Booking'];
    const items = deriveThreadItems(base({ live: [user('u1'), asst('a1', '', [askCall(four)])] }));
    expect(asks(items)[0].saveAll).toContain('You work at Booking.');
  });

  it('never on a question between readings of one thing', () => {
    const items = deriveThreadItems(
      base({ live: [user('u1'), asst('a1', '', [askCall(['Porto, Portugal', 'Porto Alegre'])])] }),
    );
    expect(asks(items)[0].saveAll).toBeNull();
  });
});
