// JS surface of the local mera-on-device-llm Expo module: Apple Foundation
// Models (the on-device Apple Intelligence model), iOS 26 and later only.
//
// Resolution is lazy and guarded: on Android, in jest, or in any build without
// the native module, `availability()` answers `unsupportedPlatform` and every
// call rejects with ERR_AFM_UNAVAILABLE, so callers have one unavailable path.
// Nothing here caches availability: Apple Intelligence can be switched on, or
// its model finish downloading, while the app runs.

import { requireNativeModule } from 'expo-modules-core';

export type OnDeviceLlmUnavailableReason =
  | 'deviceNotEligible'
  | 'appleIntelligenceNotEnabled'
  | 'modelNotReady'
  | 'appLanguageNotSupported'
  | 'deviceLanguageNotSupported'
  | 'osTooOld'
  | 'unsupportedPlatform'
  | 'unknown';

export type OnDeviceLlmAvailability = {
  available: boolean;
  /** Null when available. */
  reason: OnDeviceLlmUnavailableReason | null;
};

export type OnDeviceLlmErrorCode =
  | 'ERR_AFM_GUARDRAIL'
  | 'ERR_AFM_REFUSAL'
  | 'ERR_AFM_CONTEXT'
  | 'ERR_AFM_LANGUAGE'
  | 'ERR_AFM_UNAVAILABLE'
  | 'ERR_AFM_BUSY'
  | 'ERR_AFM_CANCELLED'
  | 'ERR_AFM_UNKNOWN';

export type OnDeviceLlmOptions = { temperature?: number; maxTokens?: number };

type Subscription = { remove: () => void };

interface NativeOnDeviceLlm {
  availability(appLanguage: string): Promise<{ available: boolean; reason: string | null }>;
  prewarm(instructions: string): void;
  respond(instructions: string, prompt: string, args: OnDeviceLlmOptions): Promise<string>;
  startStream(id: string, instructions: string, prompt: string, args: OnDeviceLlmOptions): void;
  cancel(id: string): void;
  addListener(event: 'onToken', listener: (e: { id: string; delta: string }) => void): Subscription;
  addListener(event: 'onDone', listener: (e: { id: string }) => void): Subscription;
  addListener(event: 'onError', listener: (e: { id: string; code: string }) => void): Subscription;
}

let nativeModule: NativeOnDeviceLlm | null | undefined;

function resolveNative(): NativeOnDeviceLlm | null {
  if (nativeModule !== undefined) return nativeModule;
  try {
    nativeModule = requireNativeModule<NativeOnDeviceLlm>('MeraOnDeviceLlm');
  } catch {
    nativeModule = null;
  }
  return nativeModule;
}

/** A failed call. `code` is stable; the message never quotes the prompt. */
export class OnDeviceLlmError extends Error {
  readonly code: OnDeviceLlmErrorCode;
  constructor(code: OnDeviceLlmErrorCode) {
    super(`On-device Apple model call failed (${code})`);
    this.name = 'OnDeviceLlmError';
    this.code = code;
  }
}

const KNOWN_CODES: readonly string[] = [
  'ERR_AFM_GUARDRAIL',
  'ERR_AFM_REFUSAL',
  'ERR_AFM_CONTEXT',
  'ERR_AFM_LANGUAGE',
  'ERR_AFM_UNAVAILABLE',
  'ERR_AFM_BUSY',
  'ERR_AFM_CANCELLED',
];

function toError(code: unknown): OnDeviceLlmError {
  return new OnDeviceLlmError(
    typeof code === 'string' && KNOWN_CODES.includes(code) ? (code as OnDeviceLlmErrorCode) : 'ERR_AFM_UNKNOWN',
  );
}

/** True for a guardrail or refusal: the model declined, nothing broke. */
export function isOnDeviceLlmRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ERR_AFM_GUARDRAIL' || code === 'ERR_AFM_REFUSAL';
}

const KNOWN_REASONS: readonly string[] = [
  'deviceNotEligible',
  'appleIntelligenceNotEnabled',
  'modelNotReady',
  'appLanguageNotSupported',
  'deviceLanguageNotSupported',
  'osTooOld',
];

/** Whether the on-device Apple model can run now, for Mera's app language. */
export async function availability(appLanguage: string): Promise<OnDeviceLlmAvailability> {
  const native = resolveNative();
  if (!native) return { available: false, reason: 'unsupportedPlatform' };
  try {
    const r = await native.availability(appLanguage);
    if (r.available) return { available: true, reason: null };
    const reason = r.reason && KNOWN_REASONS.includes(r.reason) ? (r.reason as OnDeviceLlmUnavailableReason) : 'unknown';
    return { available: false, reason };
  } catch {
    return { available: false, reason: 'unknown' };
  }
}

/** Best effort: loads the model ahead of a request. */
export function prewarm(instructions = ''): void {
  try {
    resolveNative()?.prewarm(instructions);
  } catch {
    // Best effort only.
  }
}

export async function respond(
  instructions: string,
  prompt: string,
  options: OnDeviceLlmOptions = {},
): Promise<string> {
  const native = resolveNative();
  if (!native) throw new OnDeviceLlmError('ERR_AFM_UNAVAILABLE');
  try {
    return await native.respond(instructions, prompt, options);
  } catch (e) {
    throw toError((e as { code?: unknown } | null)?.code);
  }
}

let streamCounter = 0;

/**
 * Streams the reply: `onToken(delta)` per new piece, then exactly one of
 * `onDone()` or `onError(error)`. `cancel()` stops it; a cancelled stream ends
 * with `onError(ERR_AFM_CANCELLED)`.
 */
export function stream(
  instructions: string,
  prompt: string,
  options: OnDeviceLlmOptions,
  handlers: { onToken: (delta: string) => void; onDone: () => void; onError: (error: OnDeviceLlmError) => void },
): { cancel: () => void } {
  const native = resolveNative();
  if (!native) {
    handlers.onError(new OnDeviceLlmError('ERR_AFM_UNAVAILABLE'));
    return { cancel: () => {} };
  }
  const id = `s${++streamCounter}`;
  let settled = false;
  const subs: Subscription[] = [];
  const finish = () => {
    settled = true;
    subs.forEach((s) => s.remove());
  };
  subs.push(
    native.addListener('onToken', (e) => {
      if (e.id === id && !settled) handlers.onToken(e.delta);
    }),
    native.addListener('onDone', (e) => {
      if (e.id !== id || settled) return;
      finish();
      handlers.onDone();
    }),
    native.addListener('onError', (e) => {
      if (e.id !== id || settled) return;
      finish();
      handlers.onError(toError(e.code));
    }),
  );
  try {
    native.startStream(id, instructions, prompt, options);
  } catch (e) {
    finish();
    handlers.onError(toError((e as { code?: unknown } | null)?.code));
  }
  return {
    cancel: () => {
      if (!settled) native.cancel(id);
    },
  };
}
