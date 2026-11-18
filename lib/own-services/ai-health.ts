import { create } from 'zustand';
import type { LlmTransport } from '@/lib/llm/cloudComplete';
import { useOwnNewsHealth } from './news-latch';
import { ownAiState } from './own-ai-state';
import { ownNewsState } from './own-news-state';
import { usePodHealth } from './pod-health';
import { podState } from './pod-state';

/** What the own AI service's last call said: 'down' only for a network error, a timeout, 401, 403 or 5xx. */
export const useOwnAiHealth = create<{ health: 'ok' | 'down' | null }>(() => ({ health: null }));

export type DownService = 'pod' | 'ai' | 'news';

/** The one service whose line shows, in the order paired server, own AI service, own news server. */
export const useServiceDown = create<{ down: DownService | null }>(() => ({ down: null }));

const isDown = (h: string | null) => h === 'unreachable' || h === 'refused';

// Derived on a store change, not on render, so a screen with no mode on never re-renders for it.
function recompute(): void {
  const down: DownService | null =
    podState.get() !== null && isDown(usePodHealth.getState().health)
      ? 'pod'
      : ownAiState.get()?.on === true && useOwnAiHealth.getState().health === 'down'
        ? 'ai'
        : ownNewsState.get()?.on === true && isDown(useOwnNewsHealth.getState().health)
          ? 'news'
          : null;
  if (down !== useServiceDown.getState().down) useServiceDown.setState({ down });
}

const signature = () => {
  const c = ownAiState.get();
  return JSON.stringify([c?.on === true, c?.baseUrl ?? null, c?.model ?? null, c?.key ?? null]);
};

// The old service's trouble says nothing about a new address, key, model or a switched-off mode.
let last: string | null = null;
ownAiState.useStore.subscribe((s) => {
  if (!s.hydrated) {
    last = null;
    return;
  }
  const now = signature();
  const before = last;
  last = now;
  if (before !== null && before !== now) useOwnAiHealth.setState({ health: null });
});
for (const store of [ownAiState.useStore, ownNewsState.useStore, podState.useStore, useOwnAiHealth, useOwnNewsHealth, usePodHealth]) {
  (store as { subscribe(l: () => void): unknown }).subscribe(recompute);
}
recompute();

const NETWORK = /network|fetch|timeout|longer than the call timeout|econn|enotfound|socket/i;

/** Whether a failure says the service is not answering: 429, a caller stop and a bad reply do not. */
function failureIsDown(err: unknown): boolean {
  const e = err as { statusCode?: number; name?: string; message?: string } | null;
  if (typeof e?.statusCode === 'number') return e.statusCode === 401 || e.statusCode === 403 || e.statusCode >= 500;
  if (e?.name === 'CallerAbortError' || e?.name === 'EmptyReplyError') return false;
  return e?.name === 'TimeoutError' || e instanceof TypeError || NETWORK.test(e?.message ?? '');
}

/** A batch keeps each failure on its row as text: "model request failed: 503". */
function batchFailureIsDown(message: string): boolean {
  const status = /model request failed: (\d{3})/.exec(message)?.[1];
  return status ? failureIsDown({ statusCode: Number(status) }) : !/abort/i.test(message) && NETWORK.test(message);
}

/** The own transport, writing the health. A call that outlives a change of address is not counted. */
export function withAiHealth(inner: LlmTransport): LlmTransport {
  const started = signature();
  const note = (outcome: 'ok' | 'down' | null) => {
    if (outcome && signature() === started) useOwnAiHealth.setState({ health: outcome });
  };
  const onError = (err: unknown) => note(failureIsDown(err) ? 'down' : null);
  return {
    ...inner,
    async complete(request, options) {
      try {
        const reply = await inner.complete(request, options);
        note('ok');
        return reply;
      } catch (err) {
        onError(err);
        throw err;
      }
    },
    async batch(calls, route, options) {
      const results = await inner.batch(calls, route, options);
      if (results.some((r) => !r.error)) note('ok');
      else if (results.length > 0 && batchFailureIsDown(results[0].error ?? '')) note('down');
      return results;
    },
    async *chat(request) {
      try {
        let first = true;
        for await (const event of inner.chat(request)) {
          if (first) note('ok');
          first = false;
          yield event;
        }
      } catch (err) {
        onError(err);
        throw err;
      }
    },
  };
}
