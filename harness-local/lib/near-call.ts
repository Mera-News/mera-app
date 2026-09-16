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

export interface NearUsage {
  promptTokens: number;
  completionTokens: number;
  /** NEAR returns `prompt_tokens_details: null` today, so this is 0 and means
   *  NOT REPORTED rather than "nothing was cached". */
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
      return fail(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
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
    return fail(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  } finally {
    clearTimeout(timer);
  }
}
