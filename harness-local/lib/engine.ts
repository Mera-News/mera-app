// harness-local — `--engine`: which text model a runner drives, and for the
// on-device engines, the app's own on-device call path rebuilt from pure parts.
//
//   cloud       the runner's existing NEAR path and cloud prompts (default)
//   afm         Apple's on-device model through harness-local/afm (macOS)
//   qwen-local  the pinned Qwen3.5-4B GGUF on llama-server :8080, the phone's Mera text model
//   nano-proxy  Gemma 4 E4B on llama-server :8081. A PROXY for Gemini Nano, never Nano itself:
//               same input limit and JSON-in-text structured output, a different model.
//
// A non-cloud engine also switches the PROMPTS to lib/news-harness/on-device/<flow>/,
// which is what the phone sends on every on-device engine. The call shape mirrors
// lib/mera-protocol-toolkit/core/inference.ts (not importable: it loads llama.rn):
// guided JSON on AFM, a json_schema grammar on Qwen, the schema in the prompt on
// Nano, read with readStructured, one retry with the JSON reminder.

import { afmAvailability, afmCall } from '../adapters/afm-llm';
import { postCompletion, type NearResult } from './near-call';
import { LOCAL_CONTEXT_TOKENS } from '../../lib/mera-protocol-toolkit/core/context-size';
import { readStructured, type JsonSchema } from '../../lib/mera-protocol-toolkit/core/structured-json';
import { ON_DEVICE_CHAT_MAX_TOKENS, promptBudgetTokens } from '../../lib/news-harness/on-device/shared';

export const ENGINES = ['cloud', 'afm', 'qwen-local', 'nano-proxy'] as const;
export type Engine = (typeof ENGINES)[number];
export type LocalEngine = Exclude<Engine, 'cloud'>;

/** `--engine <id>`, default cloud. An unknown id is a startup error, before any call. */
export function parseEngine(argv: readonly string[]): Engine {
  const i = argv.indexOf('--engine');
  if (i === -1) return 'cloud';
  const id = argv[i + 1];
  if (!(ENGINES as readonly string[]).includes(id ?? '')) {
    throw new Error(`harness-local: --engine must be one of ${ENGINES.join(', ')} (got ${JSON.stringify(id)}).`);
  }
  return id as Engine;
}

const LLAMA_URL = {
  'qwen-local': process.env.NEWS_HARNESS_QWEN_URL ?? 'http://127.0.0.1:8080/v1',
  'nano-proxy': process.env.NEWS_HARNESS_NANO_PROXY_URL ?? 'http://127.0.0.1:8081/v1',
} as const;

/** Gemini Nano reports its INPUT limit (~4000) as its context size. */
const NANO_INPUT_TOKENS = 4000;

/** Copied from inference.ts: the structured retry's second prompt. */
export const JSON_REMINDER = 'Reply with only JSON that matches the schema. No other text.';

/** What the app's contextSize() answers for this engine. Null when AFM cannot run. */
export async function engineContextSize(engine: LocalEngine): Promise<number | null> {
  if (engine === 'afm') return (await afmAvailability()).contextSize;
  return engine === 'nano-proxy' ? NANO_INPUT_TOKENS : LOCAL_CONTEXT_TOKENS;
}

/** Fails fast with a readable reason when the engine cannot answer at all. */
export async function assertEngineReady(engine: LocalEngine): Promise<void> {
  if (engine === 'afm') {
    const a = await afmAvailability();
    if (!a.available) throw new Error(`harness-local: Apple's on-device model is not available (${a.reason}).`);
    return;
  }
  const url = LLAMA_URL[engine].replace(/\/v1$/, '/health');
  const ok = await fetch(url).then((r) => r.ok, () => false);
  if (!ok) throw new Error(`harness-local: no llama-server at ${url}. See harness-local/README.md, "On-device engines".`);
}

export interface LocalCall {
  system: string;
  prompt: string;
  maxTokens: number;
  temperature: number;
  schema?: JsonSchema;
}

/** One call, one attempt. */
export function callLocal(engine: LocalEngine, c: LocalCall): Promise<NearResult> {
  if (engine === 'afm') {
    return afmCall({
      instructions: c.system,
      prompt: c.prompt,
      schema: c.schema ? JSON.stringify(c.schema) : undefined,
      temperature: c.temperature,
      maxTokens: c.maxTokens,
    });
  }
  const nano = engine === 'nano-proxy';
  // Nano has no guided generation: the Kotlin module appends the schema to the prompt.
  const prompt =
    nano && c.schema ? `${c.prompt}\n\nReply with only JSON matching this schema: ${JSON.stringify(c.schema)}` : c.prompt;
  return postCompletion({
    baseUrl: LLAMA_URL[engine],
    apiKey: 'local',
    model: engine,
    messages: [...(c.system ? [{ role: 'system', content: c.system }] : []), { role: 'user', content: prompt }],
    temperature: c.temperature,
    maxTokens: c.maxTokens,
    // The app's llama.rn knobs (inference.ts); thinking off.
    enableThinking: false,
    topP: 0.9,
    topK: 40,
    responseFormat: !nano && c.schema ? { type: 'json_schema', json_schema: { schema: c.schema } } : undefined,
    timeoutMs: 300_000,
  });
}

/**
 * A failure the phone could not have caused: the bridge or server is down, or
 * the engine is busy or unavailable (the app defers those). Everything else
 * (guardrail, refusal, context, a reply that never fit the schema) is a model
 * outcome the user would see, and counts as a FAIL, never as a dropped row.
 */
export function isTransportError(error: string | null): boolean {
  if (!error) return false;
  if (error === STRUCTURED_OUTPUT_ERROR) return false;
  if (error.startsWith('ERR_AFM_')) return error === 'ERR_AFM_UNAVAILABLE' || error === 'ERR_AFM_BUSY';
  // llama-server answers an oversized prompt with a 400: the model's limit, not the wire.
  if (/^HTTP 400\b/.test(error) && /context|exceed/i.test(error)) return false;
  return true;
}

export const STRUCTURED_OUTPUT_ERROR = 'StructuredOutputError';

export interface StructuredOutcome<T> {
  value: T | undefined;
  /** Every attempt made, the retry included. */
  attempts: NearResult[];
  error: string | null;
}

/** inferStructured: two attempts, the second with the JSON reminder; an engine error ends it. */
export async function respondStructuredLocal<T>(
  engine: LocalEngine,
  c: LocalCall & { schema: JsonSchema },
): Promise<StructuredOutcome<T>> {
  const attempts: NearResult[] = [];
  for (const prompt of [c.prompt, `${c.prompt}\n\n${JSON_REMINDER}`]) {
    const r = await callLocal(engine, { ...c, prompt });
    attempts.push(r);
    if (r.error) return { value: undefined, attempts, error: r.error };
    const value = readStructured(r.content, c.schema);
    if (value !== undefined) return { value: value as T, attempts, error: null };
  }
  return { value: undefined, attempts, error: STRUCTURED_OUTPUT_ERROR };
}

/**
 * One on-device chat turn, as lib/llm/agents/on-device/run.ts runs it: the
 * prompt sized to the engine's window, 512 output tokens, temperature 0.3.
 */
export async function onDeviceChatTurn<T>(
  engine: LocalEngine,
  system: string,
  schema: JsonSchema,
  buildPrompt: (budgetTokens: number) => string,
): Promise<StructuredOutcome<T> & { prompt: string }> {
  const budget = promptBudgetTokens({
    contextSize: await engineContextSize(engine),
    maxTokens: ON_DEVICE_CHAT_MAX_TOKENS,
    system,
    schemaJson: JSON.stringify(schema),
  });
  const prompt = buildPrompt(budget);
  const out = await respondStructuredLocal<T>(engine, {
    system,
    prompt,
    schema,
    maxTokens: ON_DEVICE_CHAT_MAX_TOKENS,
    temperature: 0.3,
  });
  return { ...out, prompt };
}
