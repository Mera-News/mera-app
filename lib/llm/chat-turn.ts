// chat-turn: reads a detached chat reply back from the gateway's turn store.
//
// The gateway keeps the raw ciphertext stream by turn id, so a reply survives
// the socket. The client continues the same byte stream from its cursor; the
// keypair of the attempt is in memory for as long as this JS context lives.
// Imports gateway-fetch only.

import { whenForeground } from '../app-restart';
import { sleep } from '@/lib/utils/sleep';
import { raceSignal } from './abort-race';
import {
  authFetch,
  CallerAbortError,
  getAuthHeaders,
  turnUrl,
  UPSTREAM_ALIGNED_TIMEOUT_MS,
  type ChatTurn,
  type StreamHandle,
} from './gateway-fetch';

const POLL_MS = 1_000;
const MAX_POLL_MS = 4_000;
const READ_TIMEOUT_MS = 15_000;

/** The silence a poll accepts once bytes are flowing: the live stream's idle
 *  window (STREAM_IDLE_TIMEOUT_MS; chat-response imports this file). */
const TURN_STALL_MS = 30_000;

export interface TurnResume {
  turn: ChatTurn;
  /** True once the app has left since the attempt began. */
  left: () => boolean;
  /** False for a `stream: false` leg, whose store holds one JSON body. */
  streamed: boolean;
}

/** The reader the SSE path reads, socket first and the store after. */
export interface TurnReader {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel(): Promise<void>;
  /** On the store now, not the socket. */
  polling(): boolean;
  /** The idle window ran out while the app was away: leave the socket. False
   *  when the app stayed, which makes the silence a real stall. */
  takeOver(): boolean;
}

/** The store has no complete reply for this turn: re-send the leg. */
export class TurnResumeError extends Error {
  constructor(why: string) {
    super(`[CloudLLM] turn not resumable: ${why}`);
    this.name = 'TurnResumeError';
  }
}

/** One step of the poll. `done` means the bytes reach the end of the reply. */
function storePoller(resume: TurnResume, signal?: AbortSignal) {
  const { turn } = resume;
  let delay = POLL_MS;
  let waited = 0;
  let first = true;
  let ended: 'done' | 'failed' | null = null;

  const waitMore = (ms: number) => {
    waited += ms;
    if (waited >= (turn.bytes > 0 ? TURN_STALL_MS : UPSTREAM_ALIGNED_TIMEOUT_MS)) throw new TurnResumeError('stalled');
    delay = Math.min(delay * 2, MAX_POLL_MS);
  };

  return async (): Promise<{ done: true } | { done: false; value: Uint8Array }> => {
    for (;;) {
      if (ended === 'done') return { done: true };
      if (ended === 'failed') throw new TurnResumeError('failed after partial bytes');
      if (!first) await raceSignal(sleep(delay), signal).catch(() => { /* checked next */ });
      first = false;
      if (signal?.aborted) throw new CallerAbortError('cloudChatStream: stopped');

      let response: Response;
      try {
        // authFetch brings the 401 re-mint, the 503 retry, the hold while away
        // and the interactive lane's 1s spacing.
        response = await authFetch(
          `${turnUrl(turn.id!)}?after=${turn.bytes}`,
          { method: 'GET', headers: await getAuthHeaders(), ...(signal ? { signal } : {}) },
          { lane: 'interactive', maxTimeoutAttempts: 1, requestTimeoutMs: READ_TIMEOUT_MS },
        );
      } catch (err) {
        if (signal?.aborted) throw new CallerAbortError('cloudChatStream: stopped', err);
        waitMore(delay);
        continue;
      }
      if (response.status === 404 || response.status === 400) throw new TurnResumeError('gone');
      if (!response.ok) {
        waitMore(delay);
        continue;
      }

      const status = response.headers.get('X-Mera-Turn-Status');
      const upstream = Number(response.headers.get('X-Mera-Turn-Upstream-Status') ?? 200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (status === 'done') ended = upstream >= 200 && upstream < 300 ? 'done' : 'failed';
      else if (status !== 'running') ended = 'failed';

      if (bytes.length > 0) {
        turn.bytes += bytes.length;
        waited = 0;
        delay = POLL_MS;
        return { done: false, value: bytes };
      }
      if (ended === 'done' && turn.bytes === 0) throw new TurnResumeError('empty');
      if (ended === null) waitMore(delay);
    }
  };
}

/** Socket bytes until the app has left and the socket gives out, then the store. */
export function turnReader(
  socket: ReadableStreamDefaultReader<Uint8Array> | null,
  resume: TurnResume,
  handle: StreamHandle | undefined,
  signal?: AbortSignal,
): TurnReader {
  const { turn, left } = resume;
  let onStore = socket === null;
  let stopped = false;
  const poll = storePoller(resume, signal);

  const leaveSocket = () => {
    onStore = true;
    handle?.abort();
    void socket?.cancel().catch(() => { /* already dead */ });
  };

  return {
    polling: () => onStore,
    takeOver: () => {
      if (onStore || !left()) return false;
      leaveSocket();
      return true;
    },
    cancel: async () => {
      stopped = true;
      await socket?.cancel();
    },
    read: async () => {
      if (!onStore) {
        try {
          const result = await socket!.read();
          if (!result.done) {
            turn.bytes += result.value.byteLength;
            return result;
          }
          if (stopped || !left()) return result;
        } catch (err) {
          if (stopped || !left()) throw err;
        }
        onStore = true;
      }
      if (stopped) return { done: true, value: undefined };
      turn.polled = true;
      await whenForeground(signal);
      return (await poll()) as ReadableStreamReadResult<Uint8Array>;
    },
  };
}

/** The whole stored reply of a buffered leg. */
export async function readStoredTurn(resume: TurnResume, signal?: AbortSignal): Promise<string> {
  resume.turn.polled = true;
  const poll = storePoller(resume, signal);
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const step = await poll();
    if (step.done) return text + decoder.decode();
    text += decoder.decode(step.value, { stream: true });
  }
}
