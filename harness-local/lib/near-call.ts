import { stripLeakedReasoning } from '../../lib/llm/reasoning-leak';
// harness-local — the one place a runner posts a completion.
//
// Both runners and (from U5) replay-persona-chat.ts go through this, so a
// measurement is never an artefact of one script's request shape. It records
// what the app's own paths record: the model the provider answered as, the
// finish reason, the usage split including the reasoning trace, and the wall
// time. Nothing here is app code, and nothing here is imported by the bundle.
//
// LANE. `near` posts straight to the NEAR AI Cloud API, which is what every
// pre-existing harness script does and what the MODEL_FALLBACKS table was
// measured on. The gateway lane arrives separately: it adds a JWT, an E2EE
// envelope and a hedge, none of which change what the model sees but all of
// which move latency, so mixing them in one number would be wrong.

/**
 * True when the model returned a reasoning trace inside `content` instead of
 * `reasoning_content`. Delegates to the app's own stripper so the harness and
 * the shipped decrypt sites agree on what a leak is.
 *
 * Detected, never stripped: on a measurement run the leak IS the result, and a
 * trace inside content shares the output budget with the answer, which is how
 * an arm ends up truncated with `reasoningTokens: 0`.
 */
export function hasReasoningLeak(content: string): boolean {
  return content.length > 0 && stripLeakedReasoning(content) !== content;
}

/**
 * The provider refused because the API key is out of budget. THROWN, not
 * returned as a per-call error, because it is a run-ending condition and not a
 * property of the call: every subsequent request will fail the same way. A run
 * that records it as an ordinary error produces a file full of empty rows that
 * looks like a model failing, which is what happened before this existed.
 *
 * Verified shape (2026-09-16):
 *   HTTP 402
 *   {"error":{"message":"API key spend limit exceeded. Spent: $10.004511644,
 *     Limit: $10.00","type":"api_key_limit_exceeded",...}}
 */
export class SpendLimitError extends Error {
  readonly spent: string | null;
  readonly limit: string | null;
  readonly raw: string;
  constructor(message: string, spent: string | null, limit: string | null, raw: string) {
    super(message);
    this.name = 'SpendLimitError';
    this.spent = spent;
    this.limit = limit;
    this.raw = raw;
  }
}

/** Reads the spend figures out of the provider's message, when they are there.
 *  Exported so the self-test can pin the shape: the provider could change this
 *  wording, and a silent miss turns the run back into a file of empty rows. */
export function parseSpendLimit(body: string): SpendLimitError | null {
  let type: string | undefined;
  let message = '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; type?: string } };
    type = parsed.error?.type;
    message = parsed.error?.message ?? '';
  } catch {
    message = body;
  }
  // Keyed on the machine-readable type first, with the human message as a
  // fallback so a shape change does not silently turn this back into 91 error
  // rows.
  const isLimit =
    type === 'api_key_limit_exceeded' || /spend limit exceeded|quota|insufficient/i.test(message);
  if (!isLimit) return null;
  const spent = /Spent:\s*\$?([0-9.]+)/i.exec(message)?.[1] ?? null;
  const limit = /Limit:\s*\$?([0-9.]+)/i.exec(message)?.[1] ?? null;
  return new SpendLimitError(message || 'API key spend limit exceeded', spent, limit, body);
}

export interface NearUsage {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from NEAR's prefix cache, read from
   *  `usage.prompt_tokens_details.cached_tokens`.
   *
   *  It is reported only once a prefix has been seen before: measured on two
   *  back-to-back calls with an identical 1023-token system prompt, the first
   *  returned `prompt_tokens_details: null` and the second
   *  `{"cached_tokens": 960}`. So 0 on a FIRST call means nothing was cached
   *  yet, while 0 across a whole run of repeated prompts means the field was
   *  never populated. The report distinguishes the two rather than asserting
   *  either. A corpus run repeats its prompts by construction, so real cache
   *  hits are the expected case and they are priced at the cached rate. */
  cachedTokens: number;
  /** The thinking trace, billed inside the completion budget. */
  reasoningTokens: number;
}

export interface NearToolCall {
  name: string;
  argumentsRaw: string;
}

export interface NearResult {
  content: string;
  toolCalls: NearToolCall[];
  finishReason: string;
  /** True when the provider stopped at the token cap. A truncated tool call
   *  can lose its arguments entirely, which reads as a model failure unless
   *  this is recorded alongside. */
  truncated: boolean;
  usage: NearUsage | null;
  /** What the provider says answered. Compared against the requested id so a
   *  latency figure is never credited to the wrong model. */
  modelSent: string | null;
  latencyMs: number;
  error: string | null;
}

export interface NearRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  maxTokens?: number;
  /** Chat gear is thinking ON; the scoring and topic prompts run it off. */
  enableThinking: boolean;
  tools?: unknown[];
  toolChoice?: 'auto' | 'none';
  timeoutMs?: number;
}

interface RawResponse {
  model?: string;
  choices?: {
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    reasoning_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  };
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Posts a PREBUILT body. The chat runner uses this with
 * lib/chat-turn.ts's buildChatTurnBody, so the body it sends is the same
 * object replay-persona-chat sends rather than a second reconstruction of it.
 */
export async function postBody(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<NearResult> {
  return postPrepared(baseUrl, apiKey, body, timeoutMs);
}

export async function postCompletion(req: NearRequest): Promise<NearResult> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: false,
    // Mirrors lib/llm/cloudComplete.ts: without this, a thinking model burns
    // the whole budget on reasoning_content and returns empty content.
    chat_template_kwargs: { enable_thinking: req.enableThinking },
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.tools) {
    body.tools = req.tools;
    body.tool_choice = req.toolChoice ?? 'auto';
  }

  return postPrepared(req.baseUrl, req.apiKey, body, req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

/** The single transport: one place that times, posts, parses and classifies. */
async function postPrepared(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<NearResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const fail = (error: string): NearResult => ({
    content: '',
    toolCalls: [],
    finishReason: '-',
    truncated: false,
    usage: null,
    modelSent: null,
    latencyMs: Date.now() - started,
    error,
  });

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // 402 is the budget, not the call. Throwing aborts the run on the FIRST
      // one instead of grinding through every remaining call to record the same
      // refusal as data.
      if (res.status === 402) {
        const limitErr = parseSpendLimit(body);
        if (limitErr) throw limitErr;
      }
      return fail(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as RawResponse;
    const choice = json.choices?.[0];
    const msg = choice?.message;
    // Same fallback the app uses: a thinking model can return empty content
    // with the text under reasoning_content when thinking was not disabled.
    const content = msg?.content || msg?.reasoning_content || '';
    const finishReason = choice?.finish_reason ?? '-';
    return {
      content,
      toolCalls: (msg?.tool_calls ?? []).map((t) => ({
        name: t.function?.name ?? '?',
        argumentsRaw: t.function?.arguments ?? '',
      })),
      finishReason,
      truncated: finishReason === 'length',
      usage: json.usage
        ? {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            cachedTokens: json.usage.prompt_tokens_details?.cached_tokens ?? 0,
            reasoningTokens: json.usage.reasoning_tokens ?? 0,
          }
        : null,
      modelSent: json.model ?? null,
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    // A spend limit is not a transport failure to be recorded; let it out.
    if (err instanceof SpendLimitError) throw err;
    return fail(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  } finally {
    clearTimeout(timer);
  }
}
