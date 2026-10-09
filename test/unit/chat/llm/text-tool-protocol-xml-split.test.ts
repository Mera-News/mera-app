import {
  APP_TOOL_FORMAT,
  createToolCallStreamParser,
  parseToolCallsFromText,
  type ParsedToolCall,
  type TextToolDefinition,
} from '@/lib/llm/text-tool-protocol';

const TOOLS: TextToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'saveExtractedFacts',
      description: 'Save facts.',
      parameters: { type: 'object', properties: { statement: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_place',
      description: 'Look a place up.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
    },
  },
];

// The shipped form: visible text, two XML calls (one value holds "<" and a newline), trailing text.
const REPLY =
  'Noted, Porto it is.\n' +
  '<tool_call>\n<function=saveExtractedFacts>\n<parameter=statement>\nLives in Porto\n</parameter>\n</function>\n</tool_call>\n' +
  '<tool_call>\n<function=lookup_place>\n<parameter=query>\nPorto <north>\nsecond line\n</parameter>\n<parameter=limit>\n3\n</parameter>\n</function>\n</tool_call>' +
  '\nTap the card to add it.';

const EXPECTED_TEXT = 'Noted, Porto it is.\n\n\nTap the card to add it.';
const EXPECTED_CALLS: ParsedToolCall[] = [
  { name: 'saveExtractedFacts', argumentsRaw: '{"statement":"Lives in Porto"}' },
  { name: 'lookup_place', argumentsRaw: '{"query":"Porto <north>\\nsecond line","limit":3}' },
];
const TAGS = ['<tool_call', '<function=', '<parameter=', '</tool_call'];

function feed(parts: string[]) {
  const p = createToolCallStreamParser(TOOLS, APP_TOOL_FORMAT);
  let text = '';
  const calls: ParsedToolCall[] = [];
  const pushed: string[] = [];
  for (const part of parts) {
    const r = p.push(part);
    pushed.push(r.text);
    text += r.text;
    calls.push(...r.calls);
  }
  const f = p.flush();
  pushed.push(f.text);
  text += f.text;
  calls.push(...f.calls);
  return { text, calls, pushed, unclosed: f.unclosed };
}

const leaked = (pushed: string[]) => pushed.filter((t) => TAGS.some((tag) => t.includes(tag)));

describe('text tool protocol: the shipped XML form, stream split points', () => {
  it('ships the xml form', () => {
    expect(APP_TOOL_FORMAT).toBe('xml');
  });

  it('the whole reply parses to the expected text and two calls', () => {
    expect(parseToolCallsFromText(REPLY, TOOLS, APP_TOOL_FORMAT)).toEqual({ text: EXPECTED_TEXT, calls: EXPECTED_CALLS });
  });

  it('splits visible text from calls at EVERY split point of the stream', () => {
    const whole = parseToolCallsFromText(REPLY, TOOLS, APP_TOOL_FORMAT);
    let runs = 0;
    for (let a = 0; a <= REPLY.length; a++) {
      for (const b of [a + 1, a + 7, REPLY.length]) {
        if (b > REPLY.length) continue;
        const r = feed([REPLY.slice(0, a), REPLY.slice(a, b), REPLY.slice(b)]);
        expect({ text: r.text, calls: r.calls }).toEqual(whole);
        expect(r.unclosed).toBe(false);
        expect(leaked(r.pushed)).toEqual([]);
        runs++;
      }
    }
    expect(runs).toBeGreaterThan(REPLY.length);
  });

  it('splits correctly one character at a time', () => {
    const r = feed([...REPLY]);
    expect({ text: r.text, calls: r.calls }).toEqual({ text: EXPECTED_TEXT, calls: EXPECTED_CALLS });
    expect(leaked(r.pushed)).toEqual([]);
  });
});
