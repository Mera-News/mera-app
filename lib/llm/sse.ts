// sse — minimal Server-Sent Events parser for the cloud chat stream.
//
// Deliberately standalone: no fetch, no app imports, no knowledge of the chat
// payload. It turns a byte stream into completed `data:` payload strings and
// nothing else, so it is unit-testable without mocking the network and the
// chat path stays the only place that understands OpenAI chunk shapes.
//
// Scope is exactly what the wire needs (WHATWG event-stream, minus the parts
// NEAR never sends): `data:` accumulation across lines, comment/other-field
// skipping, LF and CRLF event boundaries. `event:`/`id:`/`retry:` are ignored
// rather than surfaced — nothing consumes them.

/**
 * Incremental parser. Feed it decoded text chunks in arrival order; each
 * {@link push} returns the payloads of every event that COMPLETED in that
 * chunk (usually 0 or 1). Chunk boundaries may fall anywhere — mid-event,
 * mid-line, or between the CR and LF of a CRLF.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;

    // A trailing CR may be the first half of a CRLF split across chunks —
    // hold it back so it is not normalized into a premature line break.
    let held = '';
    if (this.buffer.endsWith('\r')) {
      held = '\r';
      this.buffer = this.buffer.slice(0, -1);
    }
    this.buffer = this.buffer.replace(/\r\n?/g, '\n');

    const events: string[] = [];
    let boundary = this.buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const payload = parseEventBlock(this.buffer.slice(0, boundary));
      this.buffer = this.buffer.slice(boundary + 2);
      if (payload !== null) events.push(payload);
      boundary = this.buffer.indexOf('\n\n');
    }

    this.buffer += held;
    return events;
  }

  /**
   * Emit any event left buffered when the stream ends without a final blank
   * line. Servers that terminate cleanly leave nothing here.
   */
  flush(): string[] {
    const rest = this.buffer.replace(/\r\n?/g, '\n');
    this.buffer = '';
    const payload = parseEventBlock(rest);
    return payload === null ? [] : [payload];
  }
}

/** Collect the `data:` lines of one event block, or null if it carries none. */
function parseEventBlock(block: string): string | null {
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue; // blank / comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') continue;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1); // single leading space only
    dataLines.push(value);
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}

/**
 * Async-iterate the completed `data:` payloads of a byte stream.
 *
 * `onChunk` fires for every raw chunk BEFORE its events are yielded — the chat
 * path uses it to rearm its idle timer on any upstream activity, including
 * chunks that complete no event.
 */
export async function* sseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onChunk?: () => void,
): AsyncGenerator<string> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk?.();
    // stream: true so a multi-byte character split across chunks is held, not
    // emitted as a replacement char (which would corrupt an E2EE hex envelope).
    yield* parser.push(decoder.decode(value, { stream: true }));
  }
  yield* parser.push(decoder.decode());
  yield* parser.flush();
}
