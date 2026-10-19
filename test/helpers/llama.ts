// Scripted llama.rn, driving the REAL lib/mera-protocol-toolkit (modelManager + the inference
// lock) and the real inference queue. llama.rn is already a jest.fn module in
// jest.setup.native.js; installLlama() gives it behaviour for one test.
//
//   jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
//   beforeEach(() => { resetFileSystem(); installLlama(['Hello', ' there.']); });
//
// Tokens are delivered one per macrotask (setImmediate, which the fake clock leaves real), so a
// stop between tokens is observable. `tokenDelayMs` uses setTimeout instead (fake-clock driven).
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { MODEL_CATALOG, RELEVANCE_MODEL } from '@/lib/mera-protocol-toolkit/core/model-catalog';
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

/** One Kev `decide()` call: the request, and what the script answered (or threw). */
export interface DecideCall {
  request: { state: unknown; questions: Record<string, unknown> };
}
/** A Kev answer: the `score` of each question (0..levels-1), or an error to throw. */
export type DecideScript = { scores: Record<string, number> } | { error: string };

const state: {
  calls: LlamaCall[];
  script: (call: LlamaCall) => LlamaScript;
  releases: number;
  loads: string[];
  live: number;
  maxLive: number;
  decideCalls: DecideCall[];
  decideScript: (call: DecideCall) => DecideScript;
} = {
  calls: [],
  script: () => [],
  releases: 0,
  loads: [],
  live: 0,
  maxLive: 0,
  decideCalls: [],
  decideScript: () => ({ scores: { rel: 2 } }),
};

/** Every completion so far, in order. Live objects. */
export const llamaCalls = (): LlamaCall[] => state.calls;
/** How many times a loaded context was released (model reloads, disposes). */
export const llamaReleases = (): number => state.releases;
/** The model id of every context loaded so far, in order. */
export const llamaLoads = (): string[] => state.loads;
/** The most contexts that were ever alive at once (must stay 1: never two models in memory). */
export const llamaMaxLive = (): number => state.maxLive;
/** Every Kev `decide()` so far, in order. */
export const decideCalls = (): DecideCall[] => state.decideCalls;

/** Scripts Kev's answers for the next `decide()` calls (default: score 2 for `rel`). */
export function installDecide(script: DecideScript | ((call: DecideCall) => DecideScript)): void {
  state.decideScript = typeof script === 'function' ? script : () => script;
}

const nextTick = (ms?: number) =>
  new Promise<void>((r) => (ms ? setTimeout(r, ms) : setImmediate(r)));

const modelIdOf = (path: string): string => path.split('/').slice(-2)[0];

function makeContext(modelPath: string) {
  let current: { call: LlamaCall; wake: (() => void) | null } | null = null;
  let released = false;
  const isKev = modelIdOf(modelPath) === RELEVANCE_MODEL.modelId;
  state.loads.push(modelIdOf(modelPath));
  state.live += 1;
  state.maxLive = Math.max(state.maxLive, state.live);
  return {
    gpu: false,
    model: isKev
      ? { size: 1024 * 1024 * 1024, decision: { type: 'kev', nOptionsMax: 16, imageInput: false, textGeneration: false } }
      : { size: 1024 * 1024 * 1024 },
    async decide(request: DecideCall['request']) {
      if (!isKev) throw new Error('this model is not a decision model of a supported type');
      const call: DecideCall = { request };
      state.decideCalls.push(call);
      await nextTick();
      const answer = state.decideScript(call);
      if ('error' in answer) throw new Error(answer.error);
      const answers: Record<string, { type: 'score'; score: number }> = {};
      for (const [id, score] of Object.entries(answer.scores)) answers[id] = { type: 'score', score };
      return { model: 'Kev-4B', answers, usage: { input_tokens: 100, output_tokens: 0 } };
    },
    async completion(
      params: Record<string, unknown> & { messages?: { role: string; content: string }[] },
      onToken?: (data: { token: string }) => void,
    ) {
      if (isKev) throw new Error('completion() is not available for this decision model');
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
      if (released) return;
      released = true;
      state.releases += 1;
      state.live -= 1;
    },
  };
}

/**
 * Gives the llama.rn mock a scripted context, puts BOTH on-device model files on the in-memory disk
 * (the test file must mock expo-file-system with ./fs) and sets processing to on-device, the only
 * mode in which the toolkit loads a model. `script` is fixed, or a function of the call (read
 * `call.messages` to answer by prompt). Kev's answers come from `installDecide`.
 */
export function installLlama(script: LlamaScript | ((call: LlamaCall) => LlamaScript)): void {
  state.calls = [];
  state.releases = 0;
  state.loads = [];
  state.live = 0;
  state.maxLive = 0;
  state.decideCalls = [];
  state.decideScript = () => ({ scores: { rel: 2 } });
  state.script = typeof script === 'function' ? script : () => script;
  const llama = jest.requireMock('llama.rn') as Record<string, jest.Mock>;
  llama.initLlama.mockImplementation(async (params: { model: string }) => makeContext(params.model));
  llama.loadLlamaModelInfo.mockResolvedValue({});
  llama.toggleNativeLog.mockResolvedValue(undefined);
  llama.addNativeLogListener.mockReturnValue({ remove: () => {} });
  for (const m of MODEL_CATALOG) placeModelFile(m.modelId);
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
}
