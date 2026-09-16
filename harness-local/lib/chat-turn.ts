// harness-local — the chat turn, built once.
//
// replay-persona-chat.ts is the instrument that produced the MODEL_FALLBACKS
// table in lib/llm/constants.ts. Its request shape is therefore not just one
// script's detail: it is the shape every chat number in this repo was measured
// with. The corpus runner has to send the SAME thing, or its numbers cannot be
// compared to those, and a second hand-written copy of the body would drift
// silently the first time either side was edited.
//
// So the body is built here, once, and both callers use it. `buildChatTurnBody`
// is pure and returns the object that gets JSON.stringify'd, which is what
// makes the extraction checkable: the self-test pins the exact bytes the
// pre-extraction script produced and compares.
//
// WIRE PARITY NOTES, carried over from the original and load-bearing:
//  - thinking is ON for chat turns, because cloudChatStream hardcodes it on. A
//    reasoning model measured with thinking off is a different gear from the
//    one the app ships, and the trace shares max_tokens with the answer.
//  - the budget is CHAT_MAX_OUTPUT_TOKENS + CHAT_REASONING_HEADROOM_TOKENS,
//    the same sum cloudChatStream sends.
//  - <context> is injected onto the LAST user message, exactly as the app does.
//
// Node-only: never imported by the app bundle.

import {
  CHAT_MAX_OUTPUT_TOKENS,
  CHAT_REASONING_HEADROOM_TOKENS,
} from '../../lib/llm/constants';

export interface ChatWireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatTurnParams {
  model: string;
  messages: ChatWireMessage[];
  tools: unknown[];
  /** Defaults ON: the app's chat gear. */
  thinking?: boolean;
  stream?: boolean;
  /** NEAR validates this, so a bad value 400s, which makes it usable as a
   *  control that the request is really reaching the provider. */
  effort?: string;
  temperature?: number;
}

/** The chat temperature the persona path has always posted. */
export const CHAT_TEMPERATURE = 0.4;

/**
 * KEY ORDER IS PART OF THE CONTRACT here, because the self-test compares the
 * serialized bytes against the shape the pre-extraction script produced. Adding
 * a field in the middle is a real change and should fail that check.
 */
export function buildChatTurnBody(p: ChatTurnParams): Record<string, unknown> {
  return {
    model: p.model,
    messages: p.messages,
    tools: p.tools,
    tool_choice: 'auto',
    max_tokens: CHAT_MAX_OUTPUT_TOKENS + CHAT_REASONING_HEADROOM_TOKENS,
    temperature: p.temperature ?? CHAT_TEMPERATURE,
    chat_template_kwargs: { enable_thinking: p.thinking ?? true },
    ...(p.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    ...(p.effort ? { reasoning_effort: p.effort } : {}),
  };
}

/**
 * Injects <context> onto the LAST user message, which is where the app puts
 * it. Returns a new array; the input is not mutated, so a repeat that reuses
 * the same history is not quietly building on the previous repeat's prompt.
 */
export function withContextOnLastUserTurn(
  systemPrompt: string,
  context: string,
  wire: ChatWireMessage[],
): ChatWireMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    ...wire.map((m, i) =>
      i === wire.length - 1 && m.role === 'user'
        ? { role: m.role, content: `${context}\n\n${m.content}` }
        : { role: m.role, content: m.content },
    ),
  ];
}
