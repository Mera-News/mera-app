// Tool use as TEXT inside the E2EE envelope.
//
// WHY THIS EXISTS. NEAR's E2EE envelope covers `messages[].content` and the
// response's `content` / `reasoning_content`, nothing else. A native `tools`
// field, `tool_choice`, a replayed `assistant.tool_calls` and the response's
// `delta.tool_calls` all travel in CLEARTEXT through Mera's gateway and NEAR's
// API layer, and the model's tool arguments carry the user's facts and home.
// So no tool field ever leaves the device: the schema is written into the
// (encrypted) system prompt in Qwen's own Hermes format, history is replayed as
// text, and the model's `<tool_call>` blocks come back inside the encrypted
// content and are parsed here after decryption. This is what the chat template
// does server-side anyway; it is just done before encryption instead of after.
//
// PURE. No React Native, no logger, no network: the eval runner and the staging
// probe import this from Node, so the app and the measurement cannot disagree
// about the wire. A purity test walks its import graph.

export interface TextToolDefinition {
  type?: string;
  function: { name: string; description?: string; parameters?: unknown };
}

export interface TextToolCallIn {
  id?: string;
  type?: string;
  function: { name: string; arguments: string };
}

export interface ProtocolMessageIn {
  role: string;
  content: string;
  tool_calls?: TextToolCallIn[];
  tool_call_id?: string;
}

// A type alias, not an interface: it must stay assignable to the
// index-signatured message shape `encryptMessages` takes.
export type ProtocolMessageOut = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export interface ParsedToolCall {
  name: string;
  /** JSON text, the same shape a native `function.arguments` carried. */
  argumentsRaw: string;
}

/**
 * `tool_choice: 'required'` has no text equivalent. The tools block asks for a
 * call, and a reply that still carries none is re-asked ONCE with this line
 * appended as a user turn. The caller owns the re-ask, never the stream.
 */
export const REQUIRED_TOOL_REASK =
  'Your reply must call one of the functions. Reply with the <tool_call> block now.';

export const TOOL_CALL_OPEN = '<tool_call>';
export const TOOL_CALL_CLOSE = '</tool_call>';

/**
 * `marker` uses tags of our own that no server-side tool parser knows, so the
 * call can never be lifted out of the content before it is encrypted, whatever
 * the provider deploys. The body is the Hermes JSON.
 */
export const MARKER_CALL_OPEN = '<mera_call>';
export const MARKER_CALL_CLOSE = '</mera_call>';
const MARKER_RESULT_OPEN = '<mera_result>';
const MARKER_RESULT_CLOSE = '</mera_result>';

function callTags(format: ToolFormat): [string, string] {
  return format === 'marker' ? [MARKER_CALL_OPEN, MARKER_CALL_CLOSE] : [TOOL_CALL_OPEN, TOOL_CALL_CLOSE];
}

/**
 * Body keys that must never leave the device on a chat request. Checked by
 * `assertNoCleartextToolFields` before every send: the app FAILS CLOSED.
 */
export const FORBIDDEN_TOOL_KEYS = [
  'tools',
  'tool_choice',
  'tool_calls',
  'tool_call_id',
  'functions',
  'function_call',
] as const;

export class CleartextToolDataError extends Error {
  constructor(readonly key: string) {
    super(`E2EE: refusing to send a chat request carrying a cleartext "${key}" field`);
    this.name = 'CleartextToolDataError';
  }
}

/** Throws when any forbidden key appears anywhere in the body. */
export function assertNoCleartextToolFields(body: unknown): void {
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((FORBIDDEN_TOOL_KEYS as readonly string[]).includes(k)) throw new CleartextToolDataError(k);
      walk(x);
    }
  };
  walk(body);
}

/**
 * Python's `json.dumps` default separators (", " and ": "), which is what the
 * Hugging Face template's `tojson` writes. Byte-closeness to what the model was
 * trained on is the point; nothing parses this side of it.
 */
function pyJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(pyJson).join(', ')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x)}`)
      .join(', ')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * `hermes`: the Qwen3 JSON form (`<tool_call>{"name", "arguments"}</tool_call>`).
 * `xml`: the Qwen3-Coder form (`<tool_call><function=..><parameter=..>`), which
 * token-matches what NEAR renders for its Qwen3.6+ models far more closely.
 * `xml-first`: the same, with the tools block BEFORE the system prompt, the
 * order Qwen's own template uses.
 */
export type ToolFormat = 'hermes' | 'xml' | 'xml-first' | 'marker';

const isXml = (format: ToolFormat): boolean => format === 'xml' || format === 'xml-first';

/** The one format the app sends. Chosen by the interleaved corpus run (P0 rule 3);
 *  the others stay only as eval arms. */
export const APP_TOOL_FORMAT: ToolFormat = 'xml';

function xmlExtra(obj: unknown, handled: string[]): string {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return '';
  let out = '';
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (handled.includes(k) || v === undefined) continue;
    out += v !== null && typeof v === 'object' ? `\n<${k}>${pyJson(v)}</${k}>` : `\n<${k}>${String(v)}</${k}>`;
  }
  return out;
}

const XML_INSTRUCTIONS =
  '\n\nIf you choose to call a function ONLY reply in the following format with NO suffix:\n\n' +
  '<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>\nvalue_1\n</parameter>\n' +
  '<parameter=example_parameter_2>\nThis is the value for the second parameter\nthat can span\nmultiple lines\n' +
  '</parameter>\n</function>\n</tool_call>\n\n<IMPORTANT>\nReminder:\n' +
  '- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags\n' +
  '- Required parameters MUST be specified\n' +
  '- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after\n' +
  '- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls\n' +
  '</IMPORTANT>';

function renderXmlTools(tools: TextToolDefinition[]): string {
  let out = '# Tools\n\nYou have access to the following functions:\n\n<tools>';
  for (const { function: f } of tools) {
    out += `\n<function>\n<name>${f.name}</name>`;
    if (f.description !== undefined) out += `\n<description>${f.description.trim()}</description>`;
    out += '\n<parameters>';
    const params = (f.parameters ?? {}) as { properties?: Record<string, Record<string, unknown>> };
    for (const [name, field] of Object.entries(params.properties ?? {})) {
      out += `\n<parameter>\n<name>${name}</name>`;
      if (field.type !== undefined) out += `\n<type>${String(field.type)}</type>`;
      if (field.description !== undefined) out += `\n<description>${String(field.description).trim()}</description>`;
      out += `${xmlExtra(field, ['name', 'type', 'description'])}\n</parameter>`;
    }
    out += `${xmlExtra(params, ['type', 'properties'])}\n</parameters>\n</function>`;
  }
  return `${out}\n</tools>${XML_INSTRUCTIONS}`;
}

/** The tools block, as Qwen's chat template renders it. */
export function renderToolsBlock(
  tools: TextToolDefinition[],
  toolChoice?: string,
  format: ToolFormat = 'hermes',
): string {
  const required =
    toolChoice === 'required'
      ? '\n\nThis reply must contain at least one <tool_call>.'
      : '';
  if (isXml(format)) return renderXmlTools(tools) + required;
  const lines = tools
    .map((t) => pyJson({ type: t.type ?? 'function', function: t.function }))
    .join('\n');
  if (format === 'marker') {
    return (
      '# Tools\n\nYou may call one or more functions to assist with the user query.\n\n' +
      'You are provided with function signatures within <tools></tools> XML tags:\n' +
      `<tools>\n${lines}\n</tools>\n\n` +
      'For each function call, return a json object with function name and arguments within ' +
      `${MARKER_CALL_OPEN}${MARKER_CALL_CLOSE} tags:\n${MARKER_CALL_OPEN}\n{"name": <function-name>, "arguments": <args-json-object>}\n${MARKER_CALL_CLOSE}\n` +
      `Function results come back to you inside ${MARKER_RESULT_OPEN}${MARKER_RESULT_CLOSE} tags.` +
      (toolChoice === 'required' ? `\n\nThis reply must contain at least one ${MARKER_CALL_OPEN}.` : '')
    );
  }
  return (
    '# Tools\n\nYou may call one or more functions to assist with the user query.\n\n' +
    'You are provided with function signatures within <tools></tools> XML tags:\n' +
    `<tools>\n${lines}\n</tools>\n\n` +
    'For each function call, return a json object with function name and arguments within ' +
    '<tool_call></tool_call> XML tags:\n<tool_call>\n{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>' +
    required
  );
}

function renderCall(c: TextToolCallIn, format: ToolFormat): string {
  let args: unknown = c.function.arguments;
  try {
    args = JSON.parse(c.function.arguments || '{}');
  } catch {
    // A malformed history call is replayed as its raw string, like the
    // template's tojson would.
  }
  if (isXml(format) && args !== null && typeof args === 'object' && !Array.isArray(args)) {
    const params = Object.entries(args as Record<string, unknown>)
      .map(([k, v]) => `<parameter=${k}>\n${typeof v === 'string' ? v : pyJson(v)}\n</parameter>\n`)
      .join('');
    return `${TOOL_CALL_OPEN}\n<function=${c.function.name}>\n${params}</function>\n${TOOL_CALL_CLOSE}`;
  }
  const [open, close] = callTags(format);
  return `${open}\n${pyJson({ name: c.function.name, arguments: args })}\n${close}`;
}

/**
 * Rewrites an OpenAI-shaped conversation so that no tool field remains:
 * the tools block joins the system message (one is added when absent),
 * an assistant's `tool_calls` become `<tool_call>` text, and consecutive
 * `role: 'tool'` messages become ONE user turn of `<tool_response>` blocks,
 * the way the template groups them. Everything returned is plain content,
 * which the caller then encrypts.
 */
export function toTextToolMessages(
  messages: ProtocolMessageIn[],
  tools: TextToolDefinition[] | undefined,
  toolChoice?: string,
  format: ToolFormat = 'hermes',
): ProtocolMessageOut[] {
  const out: ProtocolMessageOut[] = [];
  const block = tools && tools.length > 0 ? renderToolsBlock(tools, toolChoice, format) : null;
  let blockPlaced = block === null;
  for (const m of messages) {
    if (m.role === 'system') {
      if (!blockPlaced) {
        const joined = format === 'xml-first' ? `${block}\n\n${m.content}` : `${m.content}\n\n${block}`;
        out.push({ role: 'system', content: m.content ? joined : (block as string) });
        blockPlaced = true;
      } else {
        out.push({ role: 'system', content: m.content });
      }
    } else if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map((c) => renderCall(c, format));
      const content = [m.content, ...calls].filter((s) => s && s.length > 0).join('\n');
      out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      const [ro, rc] = format === 'marker' ? [MARKER_RESULT_OPEN, MARKER_RESULT_CLOSE] : ['<tool_response>', '</tool_response>'];
      const response = `${ro}\n${m.content}\n${rc}`;
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user' && prev.content.startsWith(ro)) {
        prev.content = `${prev.content}\n${response}`;
      } else {
        out.push({ role: 'user', content: response });
      }
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }
  if (!blockPlaced) out.unshift({ role: 'system', content: block as string });
  return out;
}

/** Reads ONE call body: the Hermes JSON form, else the Qwen3-Coder XML form
 *  (`<function=name><parameter=k>v</parameter></function>`). Null when neither. */
export function parseToolCallBody(body: string, tools?: TextToolDefinition[]): ParsedToolCall | null {
  const text = body.trim();
  try {
    const parsed = JSON.parse(text) as { name?: unknown; arguments?: unknown; parameters?: unknown };
    if (typeof parsed.name === 'string' && parsed.name.length > 0) {
      const args = parsed.arguments ?? parsed.parameters ?? {};
      return { name: parsed.name, argumentsRaw: typeof args === 'string' ? args : JSON.stringify(args) };
    }
  } catch {
    // fall through to the XML form
  }
  const fn = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/.exec(text);
  if (!fn) return null;
  // A declared string stays a string ("2026" is a year, not a number); every
  // other value is read as JSON when it parses, the way vLLM's parser does.
  const props = ((tools?.find((t) => t.function.name === fn[1])?.function.parameters ?? {}) as {
    properties?: Record<string, { type?: unknown }>;
  }).properties;
  const args: Record<string, unknown> = {};
  const re = /<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
  let p: RegExpExecArray | null;
  while ((p = re.exec(fn[2])) !== null) {
    const raw = p[2];
    if (props?.[p[1]]?.type === 'string') {
      args[p[1]] = raw;
      continue;
    }
    try {
      args[p[1]] = JSON.parse(raw);
    } catch {
      args[p[1]] = raw;
    }
  }
  return { name: fn[1], argumentsRaw: JSON.stringify(args) };
}

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
function heldPrefix(s: string, tag: string): number {
  for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

export interface ToolCallStreamParser {
  /** Feed decrypted text; returns the visible text and any calls it closed. */
  push(chunk: string): { text: string; calls: ParsedToolCall[] };
  /** End of stream: releases held text; an unclosed call is parsed if it can be. */
  flush(): { text: string; calls: ParsedToolCall[]; unclosed: boolean };
}

/**
 * Streaming split of visible text from `<tool_call>` blocks. Text that could
 * be the start of an opener is HELD until it resolves, so a tag split across
 * deltas never reaches the bubble. A model sometimes omits the closer between
 * two calls; a second opener closes the first.
 */
export function createToolCallStreamParser(
  tools?: TextToolDefinition[],
  format: ToolFormat = 'hermes',
): ToolCallStreamParser {
  const [OPEN, CLOSE] = callTags(format);
  let pending = '';
  let inside = false;
  let callBuf = '';

  const step = (final: boolean): { text: string; calls: ParsedToolCall[] } => {
    let text = '';
    const calls: ParsedToolCall[] = [];
    for (;;) {
      if (inside) {
        const close = pending.indexOf(CLOSE);
        const reopen = pending.indexOf(OPEN);
        const implicit = reopen >= 0 && (close < 0 || reopen < close);
        const at = implicit ? reopen : close;
        if (at < 0) {
          // Keep a possible half closer (or half reopener) in `pending`, or a
          // tag split across deltas is never found.
          const hold = final ? 0 : Math.max(heldPrefix(pending, CLOSE), heldPrefix(pending, OPEN));
          callBuf += pending.slice(0, pending.length - hold);
          pending = pending.slice(pending.length - hold);
          break;
        }
        callBuf += pending.slice(0, at);
        pending = pending.slice(implicit ? at : at + CLOSE.length);
        inside = false;
        const call = parseToolCallBody(callBuf, tools);
        if (call) calls.push(call);
        callBuf = '';
      } else {
        const open = pending.indexOf(OPEN);
        if (open >= 0) {
          text += pending.slice(0, open);
          pending = pending.slice(open + OPEN.length);
          inside = true;
          continue;
        }
        // Hold back the longest suffix that is a prefix of the opener.
        const hold = final ? 0 : heldPrefix(pending, OPEN);
        text += pending.slice(0, pending.length - hold);
        pending = pending.slice(pending.length - hold);
        break;
      }
    }
    return { text, calls };
  };

  return {
    push(chunk) {
      pending += chunk;
      return step(false);
    },
    flush() {
      const r = step(true);
      let unclosed = false;
      if (inside) {
        const call = parseToolCallBody(callBuf, tools);
        if (call) r.calls.push(call);
        else unclosed = true;
        inside = false;
        callBuf = '';
      }
      return { ...r, unclosed };
    },
  };
}

/** Whole-text form of the stream parser. */
export function parseToolCallsFromText(
  full: string,
  tools?: TextToolDefinition[],
  format: ToolFormat = 'hermes',
): { text: string; calls: ParsedToolCall[] } {
  const p = createToolCallStreamParser(tools, format);
  const a = p.push(full);
  const b = p.flush();
  return { text: a.text + b.text, calls: [...a.calls, ...b.calls] };
}
