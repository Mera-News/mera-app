// Tests for lib/llm/sse.ts — the incremental SSE parser + its reader helper.
// Pure module: no mocks, no I/O.

import { SseParser, sseEvents } from '../sse';

/** A reader over a fixed list of byte chunks, as `sseEvents` consumes it. */
function makeReader(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  let i = 0;
  return {
    read: () =>
      Promise.resolve(
        i < chunks.length
          ? { done: false as const, value: chunks[i++] }
          : { done: true as const, value: undefined },
      ),
    cancel: () => Promise.resolve(),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

const enc = (s: string) => new TextEncoder().encode(s);

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const p of gen) out.push(p);
  return out;
}

describe('SseParser', () => {
  it('returns one payload per complete event', () => {
    const p = new SseParser();
    expect(p.push('data: {"a":1}\n\ndata: {"a":2}\n\n')).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('returns nothing until the event terminator arrives', () => {
    const p = new SseParser();
    expect(p.push('data: {"a":1}')).toEqual([]);
    expect(p.push('\n')).toEqual([]);
    expect(p.push('\n')).toEqual(['{"a":1}']);
  });

  it('reassembles an event split mid-payload across chunks', () => {
    const p = new SseParser();
    expect(p.push('data: {"cho')).toEqual([]);
    expect(p.push('ices":[{"delta":{"content":"ab')).toEqual([]);
    expect(p.push('cd"}}]}\n\n')).toEqual(['{"choices":[{"delta":{"content":"abcd"}}]}']);
  });

  it('handles a chunk boundary between the CR and LF of a CRLF', () => {
    const p = new SseParser();
    expect(p.push('data: one\r')).toEqual([]);
    expect(p.push('\n\r\ndata: two\r\n\r\n')).toEqual(['one', 'two']);
  });

  it('treats CRLF event boundaries the same as LF', () => {
    const p = new SseParser();
    expect(p.push('data: x\r\n\r\n')).toEqual(['x']);
  });

  it('joins multiple data lines of one event with a newline', () => {
    const p = new SseParser();
    expect(p.push('data: line1\ndata: line2\n\n')).toEqual(['line1\nline2']);
  });

  it('strips exactly one leading space after the colon', () => {
    const p = new SseParser();
    expect(p.push('data:  padded\n\n')).toEqual([' padded']);
    expect(p.push('data:tight\n\n')).toEqual(['tight']);
  });

  it('ignores comment lines and non-data fields', () => {
    const p = new SseParser();
    expect(p.push(': keep-alive\n\n')).toEqual([]);
    expect(p.push('event: message\nid: 7\nretry: 100\ndata: real\n\n')).toEqual(['real']);
  });

  it('surfaces the [DONE] sentinel as an ordinary payload', () => {
    const p = new SseParser();
    expect(p.push('data: [DONE]\n\n')).toEqual(['[DONE]']);
  });

  it('flush() emits a trailing event that never got its blank line', () => {
    const p = new SseParser();
    expect(p.push('data: dangling\n')).toEqual([]);
    expect(p.flush()).toEqual(['dangling']);
    expect(p.flush()).toEqual([]);
  });
});

describe('sseEvents', () => {
  it('decodes and yields payloads across arbitrary chunk boundaries', async () => {
    const bytes = enc('data: a\n\ndata: b\n\ndata: [DONE]\n\n');
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 5) chunks.push(bytes.slice(i, i + 5));
    expect(await collect(sseEvents(makeReader(chunks)))).toEqual(['a', 'b', '[DONE]']);
  });

  it('holds a multi-byte UTF-8 character split across chunks', async () => {
    // "é" is 2 bytes; splitting it must not emit a replacement char, which
    // would corrupt the hex E2EE envelope the chat path decrypts.
    const bytes = enc('data: café\n\n');
    const cut = bytes.length - 3; // between the two bytes of "é"
    const events = await collect(
      sseEvents(makeReader([bytes.slice(0, cut), bytes.slice(cut)])),
    );
    expect(events).toEqual(['café']);
  });

  it('fires onChunk once per raw chunk, including ones that complete no event', async () => {
    const onChunk = jest.fn();
    await collect(
      sseEvents(makeReader([enc('data: a'), enc('\n'), enc('\ndata: b\n\n')]), onChunk),
    );
    expect(onChunk).toHaveBeenCalledTimes(3);
  });

  it('emits a trailing unterminated event when the stream ends', async () => {
    expect(await collect(sseEvents(makeReader([enc('data: last\n')])))).toEqual(['last']);
  });

  it('yields nothing for an empty stream', async () => {
    expect(await collect(sseEvents(makeReader([])))).toEqual([]);
  });
});
