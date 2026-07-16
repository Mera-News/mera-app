// harness-local — LlmPort implementation backed by the NEAR AI Cloud API
// (OpenAI-compatible /chat/completions). Fans out BatchCall entries through a
// hand-rolled concurrency limiter, with retry/backoff for transient failures.

import type { LlmPort } from '@/lib/news-harness/core/ports';
import type { BatchCall, BatchCompletionResult } from '@/lib/news-harness/core/types';

export interface LlmCallRecord {
  id: string;
  system: string;
  prompt: string;
  output: string;
  latencyMs: number;
  error?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  /** OpenAI-compatible finish reason (e.g. 'stop', 'length', 'tool_calls').
   *  Optional — added so runs can distinguish "model ran out of tokens" from
   *  a clean stop; existing consumers that don't read it are unaffected. */
  finishReason?: string;
}

interface NearAiConfig {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  concurrency?: number;
  onCall?: (rec: LlmCallRecord) => void;
}

interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const DEFAULT_CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const asDate = Date.parse(header);
    if (!Number.isNaN(asDate)) {
      const delta = asDate - Date.now();
      if (delta > 0) return delta;
    }
  }
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

/** Runs `tasks` with at most `concurrency` in flight at once, preserving each
 *  task's own result/error handling (task functions never throw — they resolve
 *  to whatever the caller wants recorded). */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

async function requestChatCompletion(
  cfg: NearAiConfig,
  body: Record<string, unknown>,
): Promise<{
  content: string;
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS - 1) {
          await sleep(retryAfterMs(response, attempt));
          continue;
        }
        const text = await response.text().catch(() => '');
        throw new Error(`NEAR AI request failed: ${response.status} ${response.statusText} — ${text}`);
      }

      const data = (await response.json()) as ChatCompletionResponse;
      const choice = data.choices?.[0];
      const msg = choice?.message;
      // Mirrors lib/llm/cloudComplete.ts's content extraction: thinking
      // models (e.g. Qwen3.6-35B-A3B-FP8) can return an empty `content` with
      // the actual text under `reasoning_content` when the request didn't
      // disable thinking — fall back so callers still get usable output.
      const content = msg?.content || msg?.reasoning_content || '';
      if (!msg?.content && msg?.reasoning_content) {
        // eslint-disable-next-line no-console
        console.warn(
          `[NearAiLlm] empty content, falling back to reasoning_content (finish_reason=${choice?.finish_reason})`,
        );
      }
      return {
        content,
        finishReason: choice?.finish_reason,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
            }
          : undefined,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Network-level errors (fetch throws) are retried the same as 5xx.
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
        continue;
      }
    }
  }
  throw lastError ?? new Error('NEAR AI request failed for an unknown reason');
}

export function createNearAiLlm(cfg: NearAiConfig): LlmPort {
  const concurrency = cfg.concurrency ?? DEFAULT_CONCURRENCY;

  return {
    async batchComplete(
      calls: BatchCall[],
      opts?: { model?: string },
    ): Promise<BatchCompletionResult[]> {
      const resultsById = new Map<string, BatchCompletionResult>();

      await runWithConcurrency(calls, concurrency, async (call) => {
        const started = Date.now();
        const body: Record<string, unknown> = {
          model: opts?.model ?? cfg.defaultModel,
          messages: [
            { role: 'system', content: call.system },
            { role: 'user', content: call.prompt },
          ],
          stream: false,
          // Mirrors lib/llm/cloudComplete.ts / submitInferenceJob.ts — without
          // this, thinking models (e.g. Qwen3.6-35B-A3B-FP8) burn the whole
          // max_tokens budget on reasoning_content and return empty content.
          chat_template_kwargs: { enable_thinking: call.enableThinking ?? false },
        };
        if (call.temperature !== undefined) body.temperature = call.temperature;
        if (call.maxTokens !== undefined) body.max_tokens = call.maxTokens;

        try {
          const { content, usage, finishReason } = await requestChatCompletion(cfg, body);
          const latencyMs = Date.now() - started;
          resultsById.set(call.id, { id: call.id, output: content });
          cfg.onCall?.({
            id: call.id,
            system: call.system,
            prompt: call.prompt,
            output: content,
            latencyMs,
            usage,
            finishReason,
          });
        } catch (err) {
          const latencyMs = Date.now() - started;
          const message = err instanceof Error ? err.message : String(err);
          // Shaped to match BatchCompletionResult exactly, mirroring
          // lib/llm/cloudComplete.ts's batch path per-call-error fallback
          // (`{ id, output: '', error }`) so decodeCloudBatchResults' fallback
          // behavior downstream is unaffected by which LlmPort is injected.
          resultsById.set(call.id, { id: call.id, output: '', error: message });
          cfg.onCall?.({
            id: call.id,
            system: call.system,
            prompt: call.prompt,
            output: '',
            latencyMs,
            error: message,
          });
        }
      });

      // Preserve caller order.
      return calls.map(
        (call) => resultsById.get(call.id) ?? { id: call.id, output: '', error: 'No result recorded' },
      );
    },

    async complete(req): Promise<string> {
      const body: Record<string, unknown> = {
        model: req.model ?? cfg.defaultModel,
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.prompt },
        ],
        stream: false,
        // Same rationale as batchComplete above. LlmPort.complete() has no
        // enableThinking field (the app's single complete() call never sets
        // it either — see cloudComplete.ts), so this is always false.
        chat_template_kwargs: { enable_thinking: false },
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

      const started = Date.now();
      const { content, usage, finishReason } = await requestChatCompletion(cfg, body);
      cfg.onCall?.({
        id: `complete:${started}`,
        system: req.systemPrompt,
        prompt: req.prompt,
        output: content,
        latencyMs: Date.now() - started,
        usage,
        finishReason,
      });
      return content;
    },
  };
}
