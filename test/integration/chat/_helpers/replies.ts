// Building model replies for a scripted gateway responder, and reading a decrypted call.
//
// Tools travel as TEXT inside the envelope (lib/llm/text-tool-protocol.ts, format 'xml'), so a
// scripted model "calls a tool" by writing the same <tool_call> XML the app parses.
import type { GatewayCall } from '@/test/helpers';

/** One tool call in the app's wire format. String values go in raw, others as JSON. */
export function toolCall(name: string, args: Record<string, unknown> = {}): string {
  const params = Object.entries(args)
    .map(([k, v]) => `<parameter=${k}>\n${typeof v === 'string' ? v : JSON.stringify(v)}\n</parameter>\n`)
    .join('');
  return `<tool_call>\n<function=${name}>\n${params}</function>\n</tool_call>`;
}

/** Prose, then any number of calls, as one reply. */
export function reply(text: string, ...calls: string[]): string {
  return [text, ...calls].filter(Boolean).join('\n');
}

const content = (call: GatewayCall, role: string): string =>
  call.messages.find((m) => m.role === role)?.content ?? '';

export const systemOf = (call: GatewayCall): string => content(call, 'system');

// The persona loop sends each leg as: system prompt, <state>, <known_facts>, optional <filters>,
// optional context lines, the <recent> conversation block, the person's message, then this leg's
// tool results as `<tool_response>name: {...}`.
const HARNESS_LINES = /^(<state>|<known_facts>|<filters>|<recent>|<tool_response>|They were answering|Their previous message|Earlier in this chat)/;

/** The person's own message in a persona-loop leg (the first user turn the loop did not write). */
export function personMessage(call: GatewayCall): string {
  return call.messages.find((m) => m.role === 'user' && !HARNESS_LINES.test(m.content))?.content ?? '';
}

/** The route leg carries the skill index in its system prompt; a skill leg carries the skill body. */
export const isRouteLeg = (call: GatewayCall): boolean => systemOf(call).includes('## Skill index');

/** Tool names whose results this leg already carries (`<tool_response>name: {...}` turns). */
export function toolResultsIn(call: GatewayCall): string[] {
  return call.messages
    .filter((m) => m.role !== 'system')
    .flatMap((m) => [...m.content.matchAll(/^([A-Za-z_]+): [[{]/gm)].map((x) => x[1]))
    .filter((name, i, all) => all.indexOf(name) === i);
}

/** True when the leg already carries a result of `tool`. */
export const hasToolResult = (call: GatewayCall, tool: string): boolean =>
  call.messages.some((m) => m.role !== 'system' && m.content.includes(`${tool}:`));
