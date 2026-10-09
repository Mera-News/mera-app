import {
  APP_TOOL_FORMAT,
  CleartextToolDataError,
  assertNoCleartextToolFields,
  createToolCallStreamParser,
  parseToolCallBody,
  parseToolCallsFromText,
  renderToolsBlock,
  toTextToolMessages,
  type TextToolDefinition,
} from '../text-tool-protocol';

const TOOL: TextToolDefinition = {
  type: 'function',
  function: {
    name: 'saveExtractedFacts',
    description: 'Save facts.',
    parameters: { type: 'object', properties: { statement: { type: 'string' } } },
  },
};

const REPLY =
  'Noted, Porto it is.\n<tool_call>\n{"name": "saveExtractedFacts", "arguments": {"statement": "Lives in Porto"}}\n</tool_call>' +
  '\n<tool_call>\n{"name": "lookup_place", "arguments": {"query": "Porto <north>"}}\n</tool_call>';

describe('text tool protocol: request', () => {
  it('writes the tools block into the system message in the Hermes form', () => {
    const out = toTextToolMessages([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }], [TOOL]);
    expect(out[0].role).toBe('system');
    expect(out[0].content.startsWith('Be brief.\n\n# Tools')).toBe(true);
    expect(out[0].content).toContain('{"type": "function", "function": {"name": "saveExtractedFacts"');
    expect(out[0].content).toContain('<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>');
  });

  it('adds a system message when there is none, and only asks for a call when required', () => {
    const out = toTextToolMessages([{ role: 'user', content: 'hi' }], [TOOL], 'required');
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('must contain at least one <tool_call>');
    expect(renderToolsBlock([TOOL], 'auto')).not.toContain('must contain');
  });

  it('replays assistant tool calls as text and groups consecutive tool results into one user turn', () => {
    const out = toTextToolMessages(
      [
        { role: 'user', content: 'I live in Porto' },
        {
          role: 'assistant',
          content: 'Checking.',
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 'lookup_place', arguments: '{"query":"Porto"}' } },
            { id: 'b', type: 'function', function: { name: 'find_similar_facts', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'a', content: '{"ok":true}' },
        { role: 'tool', tool_call_id: 'b', content: '[]' },
      ],
      undefined,
    );
    expect(out).toEqual([
      { role: 'user', content: 'I live in Porto' },
      {
        role: 'assistant',
        content:
          'Checking.\n<tool_call>\n{"name": "lookup_place", "arguments": {"query": "Porto"}}\n</tool_call>\n' +
          '<tool_call>\n{"name": "find_similar_facts", "arguments": {}}\n</tool_call>',
      },
      { role: 'user', content: '<tool_response>\n{"ok":true}\n</tool_response>\n<tool_response>\n[]\n</tool_response>' },
    ]);
    for (const m of out) expect(Object.keys(m).sort()).toEqual(['content', 'role']);
  });
});

describe('text tool protocol: response', () => {
  it('splits visible text from calls at EVERY split point of the stream', () => {
    const whole = parseToolCallsFromText(REPLY);
    expect(whole.text).toBe('Noted, Porto it is.\n\n');
    expect(whole.calls).toEqual([
      { name: 'saveExtractedFacts', argumentsRaw: '{"statement":"Lives in Porto"}' },
      { name: 'lookup_place', argumentsRaw: '{"query":"Porto <north>"}' },
    ]);
    for (let a = 0; a < REPLY.length; a++) {
      for (const b of [a + 1, a + 7, REPLY.length]) {
        if (b > REPLY.length) continue;
        const p = createToolCallStreamParser();
        const parts = [REPLY.slice(0, a), REPLY.slice(a, b), REPLY.slice(b)];
        let text = '';
        const calls = [];
        for (const part of parts) {
          const r = p.push(part);
          text += r.text;
          calls.push(...r.calls);
          expect(r.text).not.toContain('<tool');
        }
        const f = p.flush();
        text += f.text;
        calls.push(...f.calls);
        expect({ text, calls }).toEqual(whole);
      }
    }
  });

  it('a second opener closes an unclosed call', () => {
    const r = parseToolCallsFromText(
      '<tool_call>{"name": "a", "arguments": {}}<tool_call>{"name": "b", "arguments": {"x": 1}}</tool_call>',
    );
    expect(r.calls.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('an unclosed call at end of stream is parsed when whole, reported when cut', () => {
    const p = createToolCallStreamParser();
    p.push('<tool_call>{"name": "a", "arguments": {}}');
    expect(p.flush()).toEqual({ text: '', calls: [{ name: 'a', argumentsRaw: '{}' }], unclosed: false });
    const q = createToolCallStreamParser();
    q.push('<tool_call>{"name": "a", "argu');
    expect(q.flush()).toEqual({ text: '', calls: [], unclosed: true });
  });

  it('reads the Qwen3-Coder XML form too, and refuses a body with no name', () => {
    expect(
      parseToolCallBody('<function=lookup_place>\n<parameter=query>\nPorto\n</parameter>\n<parameter=n>\n3\n</parameter>\n</function>'),
    ).toEqual({ name: 'lookup_place', argumentsRaw: '{"query":"Porto","n":3}' });
    expect(parseToolCallBody('{"arguments": {}}')).toBeNull();
    expect(parseToolCallBody('not json')).toBeNull();
  });

  it('text with a lone < is not swallowed', () => {
    expect(parseToolCallsFromText('a < b and <tool is fine').text).toBe('a < b and <tool is fine');
  });
});

describe('assertNoCleartextToolFields (fail closed)', () => {
  it.each(['tools', 'tool_choice', 'tool_calls', 'tool_call_id', 'functions', 'function_call'])(
    'refuses a body carrying %s anywhere',
    (key) => {
      expect(() => assertNoCleartextToolFields({ messages: [{ role: 'user', content: 'x', [key]: [] }] })).toThrow(
        CleartextToolDataError,
      );
      expect(() => assertNoCleartextToolFields({ [key]: 'auto' })).toThrow(CleartextToolDataError);
    },
  );

  it('passes a body with none', () => {
    expect(() =>
      assertNoCleartextToolFields({ model: 'm', messages: [{ role: 'user', content: 'tool_calls' }], stream: true }),
    ).not.toThrow();
  });
});

describe('the shipped format', () => {
  const tools: TextToolDefinition[] = [
    {
      type: 'function',
      function: {
        name: 'lookup_place',
        description: 'Find a place.',
        parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
      },
    },
  ];

  it('is XML, and a replayed call parses back to the same arguments (round trip)', () => {
    expect(APP_TOOL_FORMAT).toBe('xml');
    const args = { query: '2026', limit: 3 };
    const [, assistant] = toTextToolMessages(
      [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'lookup_place', arguments: JSON.stringify(args) } }] },
      ],
      tools,
      'auto',
      APP_TOOL_FORMAT,
    ).slice(1);
    expect(assistant.content).toBe(
      '<tool_call>\n<function=lookup_place>\n<parameter=query>\n2026\n</parameter>\n<parameter=limit>\n3\n</parameter>\n</function>\n</tool_call>',
    );
    // A declared string stays a string: "2026" is not a number here.
    expect(parseToolCallsFromText(assistant.content, tools, APP_TOOL_FORMAT).calls).toEqual([
      { name: 'lookup_place', argumentsRaw: JSON.stringify(args) },
    ]);
    expect(renderToolsBlock(tools, 'auto', APP_TOOL_FORMAT)).toContain('<name>lookup_place</name>');
  });

  it('a malformed or cut call never throws and never leaks tag text into the visible reply', () => {
    for (const bad of [
      'Sure.<tool_call>\n<function=',
      'Sure.<tool_call>{"name": ',
      'Sure.<tool_call></tool_call>',
      'Sure.<tool_call>\n<parameter=q>\nx\n</parameter>\n</tool_call>',
    ]) {
      const p = createToolCallStreamParser(tools, APP_TOOL_FORMAT);
      let text = '';
      expect(() => {
        for (const ch of bad) text += p.push(ch).text;
        const f = p.flush();
        text += f.text;
        expect(f.calls).toEqual([]);
      }).not.toThrow();
      expect(text).toBe('Sure.');
    }
  });

  it('the marker format uses tags no server parser knows', () => {
    const out = toTextToolMessages([{ role: 'user', content: 'x' }], tools, 'auto', 'marker');
    expect(out[0].content).toContain('<mera_call>');
    expect(out[0].content).not.toContain('<tool_call>');
    expect(
      parseToolCallsFromText('a<mera_call>{"name": "lookup_place", "arguments": {"query": "q"}}</mera_call>', tools, 'marker'),
    ).toEqual({ text: 'a', calls: [{ name: 'lookup_place', argumentsRaw: '{"query":"q"}' }] });
  });
});
