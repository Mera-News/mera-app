// Scripted built-in model (the local `mera-on-device-llm` Expo module: Apple Foundation Models or Gemini
// Nano). The native module is the edge; the module's own JS types and error helpers stay real.
// `platformModel` defaults to 'afm' (pass `platformModel: 'nano'` or null); structured calls answer from
// the same `reply` script and record the schema text.
//
//   jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);
//   beforeEach(() => installOnDeviceLlm({ reply: 'Hello.' }));
//
// Stream tokens arrive one per macrotask (setImmediate), so a cancel between tokens is observable.
// A paced reply `{ tokens, tokenDelayMs, hang }` waits `tokenDelayMs` (setTimeout, so a fake clock
// drives it) before each token, and with `hang` a stream stays open after its tokens until cancelled.
import type {
  OnDeviceLlmAvailability,
  OnDeviceLlmErrorCode,
  OnDeviceLlmOptions,
} from '@/modules/mera-on-device-llm';

export interface OnDeviceLlmCall {
  instructions: string;
  prompt: string;
  options: OnDeviceLlmOptions;
  kind: 'respond' | 'stream' | 'structured';
  cancelled: boolean;
  /** The JSON Schema text, for a structured call. */
  schemaJson?: string;
  /** Tokens handed to the caller so far (a stream's, or the whole reply of a one-shot call). */
  delivered: string[];
}

/** `error`: fails with this code after the tokens are out. */
type Paced = { tokens: string[]; tokenDelayMs?: number; hang?: boolean; error?: OnDeviceLlmErrorCode };
type Reply = string | string[] | { error: OnDeviceLlmErrorCode } | Paced;

const isPaced = (r: Reply): r is Paced => typeof r === 'object' && !Array.isArray(r) && 'tokens' in r;
const pause = (ms?: number) => new Promise<void>((r) => (ms ? setTimeout(r, ms) : setImmediate(r)));

const state: {
  availability: OnDeviceLlmAvailability;
  reply: (call: OnDeviceLlmCall) => Reply;
  calls: OnDeviceLlmCall[];
  availabilityReads: string[];
  prewarms: number;
  platformModel: 'afm' | 'nano' | null;
  contextSize: number | null;
} = {
  availability: { available: true, reason: null },
  platformModel: 'afm',
  contextSize: 4096,
  reply: () => 'ok',
  calls: [],
  availabilityReads: [],
  prewarms: 0,
};

/** Every respond / stream call so far, in order. Live objects. */
export const onDeviceLlmCalls = (): OnDeviceLlmCall[] => state.calls;
/** The app language passed to every availability read, in order (never cached). */
export const onDeviceLlmAvailabilityReads = (): string[] => state.availabilityReads;
export const onDeviceLlmPrewarms = (): number => state.prewarms;

/** Sets what the fake answers. `reply` is a string (respond), an array of stream tokens, or an error code. */
export function installOnDeviceLlm(opts: {
  availability?: OnDeviceLlmAvailability;
  reply?: Reply | ((call: OnDeviceLlmCall) => Reply);
  platformModel?: 'afm' | 'nano' | null;
  contextSize?: number | null;
} = {}): void {
  state.availability = opts.availability ?? { available: true, reason: null };
  state.platformModel = opts.platformModel === undefined ? 'afm' : opts.platformModel;
  state.contextSize = opts.contextSize === undefined ? 4096 : opts.contextSize;
  const reply = opts.reply ?? 'ok';
  state.reply = typeof reply === 'function' ? reply : () => reply;
  state.calls = [];
  state.availabilityReads = [];
  state.prewarms = 0;
}

/** Changes availability mid-test (Apple Intelligence switched on, the model finished downloading). */
export function setOnDeviceLlmAvailability(availability: OnDeviceLlmAvailability): void {
  state.availability = availability;
}

async function answer(call: OnDeviceLlmCall): Promise<string> {
  state.calls.push(call);
  await pause();
  const reply = state.reply(call);
  if (isPaced(reply)) {
    for (const token of reply.tokens) {
      await pause(reply.tokenDelayMs);
      call.delivered.push(token);
    }
    if (reply.error) throw new actual.OnDeviceLlmError(reply.error);
    return reply.tokens.join('');
  }
  if (typeof reply === 'object' && !Array.isArray(reply)) throw new actual.OnDeviceLlmError(reply.error);
  const text = Array.isArray(reply) ? reply.join('') : reply;
  call.delivered.push(text);
  return text;
}

const actual = jest.requireActual('@/modules/mera-on-device-llm') as typeof import('@/modules/mera-on-device-llm');

export const onDeviceLlmModule = {
  ...actual,
  availability: async (appLanguage: string): Promise<OnDeviceLlmAvailability> => {
    state.availabilityReads.push(appLanguage);
    return state.availability;
  },
  prewarm: () => {
    state.prewarms += 1;
  },
  platformModel: (): 'afm' | 'nano' | null => state.platformModel,
  contextSize: async (): Promise<number | null> => state.contextSize,
  respond: async (instructions: string, prompt: string, options: OnDeviceLlmOptions = {}): Promise<string> =>
    answer({ instructions, prompt, options, kind: 'respond', cancelled: false, delivered: [] }),
  respondStructured: async (
    instructions: string,
    prompt: string,
    schemaJson: string,
    options: OnDeviceLlmOptions = {},
  ): Promise<string> => answer({ instructions, prompt, options, kind: 'structured', cancelled: false, schemaJson, delivered: [] }),
  stream: (
    instructions: string,
    prompt: string,
    options: OnDeviceLlmOptions,
    handlers: { onToken: (d: string) => void; onDone: () => void; onError: (e: InstanceType<typeof actual.OnDeviceLlmError>) => void },
  ) => {
    const call: OnDeviceLlmCall = { instructions, prompt, options, kind: 'stream', cancelled: false, delivered: [] };
    state.calls.push(call);
    const reply = state.reply(call);
    let wakeOnCancel: (() => void) | null = null;
    void (async () => {
      if (typeof reply === 'object' && !Array.isArray(reply) && !isPaced(reply)) {
        await pause();
        handlers.onError(new actual.OnDeviceLlmError(reply.error));
        return;
      }
      const paced = isPaced(reply) ? reply : { tokens: Array.isArray(reply) ? reply : [reply] };
      for (const token of paced.tokens) {
        await pause(paced.tokenDelayMs);
        if (call.cancelled) {
          handlers.onError(new actual.OnDeviceLlmError('ERR_AFM_CANCELLED'));
          return;
        }
        call.delivered.push(token);
        handlers.onToken(token);
      }
      if (paced.hang && !call.cancelled) await new Promise<void>((r) => (wakeOnCancel = r));
      await pause();
      if (call.cancelled) handlers.onError(new actual.OnDeviceLlmError('ERR_AFM_CANCELLED'));
      else if ('error' in paced && paced.error) handlers.onError(new actual.OnDeviceLlmError(paced.error));
      else handlers.onDone();
    })();
    return {
      cancel: () => {
        call.cancelled = true;
        wakeOnCancel?.();
      },
    };
  },
};
