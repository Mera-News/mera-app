// Scripted llama.rn, driving the REAL lib/mera-protocol-toolkit (modelManager + the inference
// lock) and the real inference queue. llama.rn is already a jest.fn module in
// jest.setup.native.js; installLlama() gives it behaviour for one test.
//
//   jest.mock('expo-file-system', () => require('@/test/integration/chat/_helpers/fs').fileSystemModule);
//   beforeEach(() => { resetFileSystem(); installLlama(['Hello', ' there.']); });
//
// Tokens are delivered one per macrotask (setImmediate, which the fake clock leaves real), so a
// stop between tokens is observable. `tokenDelayMs` uses setTimeout instead (fake-clock driven).
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { placeModelFile } from './fs';

export interface LlamaCall {
  /** The chat messages the toolkit passed (system prompt + the flattened prompt). */
  messages: { role: string; content: string }[];
  params: Record<string, unknown>;
  /** stopCompletion() was called while this completion ran. */
  stopped: boolean;
  /** Tokens actually delivered to the callback. */
  delivered: string[];
}

export type LlamaScript =
  | string[]
  | {
      tokens: string[];
      /** Delay between tokens through setTimeout (fake-clock driven). */
      tokenDelayMs?: number;
      /** After the tokens, keep the completion open until stopCompletion(). */
      hang?: boolean;
      /** Reported as `truncated` (the token ceiling was hit). */
      truncated?: boolean;
      /** Reject the completion with this message instead of finishing. */
      error?: string;
    };

const state: { calls: LlamaCall[]; script: (call: LlamaCall) => LlamaScript; releases: number } = {
  calls: [],
  script: () => [],
  releases: 0,
};

/** Every completion so far, in order. Live objects. */
export const llamaCalls = (): LlamaCall[] => state.calls;
/** How many times a loaded context was released (model reloads, disposes). */
export const llamaReleases = (): number => state.releases;

const nextTick = (ms?: number) =>
  new Promise<void>((r) => (ms ? setTimeout(r, ms) : setImmediate(r)));

function makeContext() {
  let current: { call: LlamaCall; wake: (() => void) | null } | null = null;
  return {
    gpu: false,
    model: { size: 1024 * 1024 * 1024 },
    async completion(
      params: Record<string, unknown> & { messages?: { role: string; content: string }[] },
      onToken?: (data: { token: string }) => void,
    ) {
      const call: LlamaCall = { messages: params.messages ?? [], params, stopped: false, delivered: [] };
      state.calls.push(call);
      const raw = state.script(call);
      const s = Array.isArray(raw) ? { tokens: raw } : raw;
      current = { call, wake: null };
      try {
        for (const token of s.tokens) {
          await nextTick(s.tokenDelayMs);
          if (call.stopped) break;
          call.delivered.push(token);
          onToken?.({ token });
        }
        if (s.hang && !call.stopped) {
          await new Promise<void>((r) => {
            if (current) current.wake = r;
          });
        }
        if (s.error && !call.stopped) throw new Error(s.error);
        const text = call.delivered.join('');
        return {
          text,
          content: text,
          truncated: !!s.truncated,
          stopped_eos: !call.stopped,
          interrupted: call.stopped,
          tokens_predicted: call.delivered.length,
          tokens_evaluated: 1,
          timings: { predicted_per_second: 20, prompt_per_second: 200 },
        };
      } finally {
        current = null;
      }
    },
    async stopCompletion() {
      if (!current) return;
      current.call.stopped = true;
      current.wake?.();
    },
    async release() {
      state.releases += 1;
    },
  };
}

/**
 * Gives the llama.rn mock a scripted context and puts the selected model's file on the in-memory
 * disk (the test file must mock expo-file-system with ./fs). `script` is fixed, or a function of
 * the call (read `call.messages` to answer by prompt).
 */
export function installLlama(script: LlamaScript | ((call: LlamaCall) => LlamaScript)): void {
  state.calls = [];
  state.releases = 0;
  state.script = typeof script === 'function' ? script : () => script;
  const llama = jest.requireMock('llama.rn') as Record<string, jest.Mock>;
  llama.initLlama.mockImplementation(async () => makeContext());
  llama.loadLlamaModelInfo.mockResolvedValue({});
  llama.toggleNativeLog.mockResolvedValue(undefined);
  llama.addNativeLogListener.mockReturnValue({ remove: () => {} });
  placeModelFile(useMeraProtocolStore.getState().selectedModelId);
}
