// Scripted Apple Foundation Models (the local `mera-on-device-llm` Expo module). The native module is the
// edge; the module's own JS types and error helpers stay real.
//
//   jest.mock('@/modules/mera-on-device-llm', () => require('@/test/helpers/on-device-llm').onDeviceLlmModule);
//   beforeEach(() => installOnDeviceLlm({ reply: 'Hello.' }));
//
// Stream tokens arrive one per macrotask (setImmediate), so a cancel between tokens is observable.
import type {
  OnDeviceLlmAvailability,
  OnDeviceLlmErrorCode,
  OnDeviceLlmOptions,
} from '@/modules/mera-on-device-llm';

export interface OnDeviceLlmCall {
  instructions: string;
  prompt: string;
  options: OnDeviceLlmOptions;
  kind: 'respond' | 'stream';
  cancelled: boolean;
}

type Reply = string | string[] | { error: OnDeviceLlmErrorCode };

const state: {
  availability: OnDeviceLlmAvailability;
  reply: (call: OnDeviceLlmCall) => Reply;
  calls: OnDeviceLlmCall[];
  availabilityReads: string[];
  prewarms: number;
} = {
  availability: { available: true, reason: null },
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
} = {}): void {
  state.availability = opts.availability ?? { available: true, reason: null };
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
  respond: async (instructions: string, prompt: string, options: OnDeviceLlmOptions = {}): Promise<string> => {
    const call: OnDeviceLlmCall = { instructions, prompt, options, kind: 'respond', cancelled: false };
    state.calls.push(call);
    await new Promise((r) => setImmediate(r));
    const reply = state.reply(call);
    if (typeof reply === 'object' && !Array.isArray(reply)) throw new actual.OnDeviceLlmError(reply.error);
    return Array.isArray(reply) ? reply.join('') : reply;
  },
  stream: (
    instructions: string,
    prompt: string,
    options: OnDeviceLlmOptions,
    handlers: { onToken: (d: string) => void; onDone: () => void; onError: (e: InstanceType<typeof actual.OnDeviceLlmError>) => void },
  ) => {
    const call: OnDeviceLlmCall = { instructions, prompt, options, kind: 'stream', cancelled: false };
    state.calls.push(call);
    const reply = state.reply(call);
    void (async () => {
      if (typeof reply === 'object' && !Array.isArray(reply)) {
        await new Promise((r) => setImmediate(r));
        handlers.onError(new actual.OnDeviceLlmError(reply.error));
        return;
      }
      for (const token of Array.isArray(reply) ? reply : [reply]) {
        await new Promise((r) => setImmediate(r));
        if (call.cancelled) {
          handlers.onError(new actual.OnDeviceLlmError('ERR_AFM_CANCELLED'));
          return;
        }
        handlers.onToken(token);
      }
      await new Promise((r) => setImmediate(r));
      if (call.cancelled) handlers.onError(new actual.OnDeviceLlmError('ERR_AFM_CANCELLED'));
      else handlers.onDone();
    })();
    return {
      cancel: () => {
        call.cancelled = true;
      },
    };
  },
};
