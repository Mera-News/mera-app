// JS surface of the local mera-on-device-llm Expo module: the phone's built-in
// model. Apple Foundation Models (Apple Intelligence) on iOS 26 and later,
// Gemini Nano (ML Kit GenAI Prompt API, AICore) on Android 8 and later.
//
// Resolution is lazy and guarded: in jest, or in any build without the native
// module, `availability()` answers `unsupportedPlatform`, `platformModel()` is
// null and every call rejects with ERR_AFM_UNAVAILABLE, so callers have one
// unavailable path. Nothing here caches availability: the built-in model can be
// switched on, or finish downloading, while the app runs. The ERR_AFM_* codes
// are internal and shared by both platforms.

import { Platform } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';

export type OnDeviceLlmUnavailableReason =
  | 'deviceNotEligible'
  | 'appleIntelligenceNotEnabled'
  | 'modelNotReady'
  | 'appLanguageNotSupported'
  | 'deviceLanguageNotSupported'
  | 'osTooOld'
  | 'needsSystemUpdate'
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
  respondStructured(instructions: string, prompt: string, schemaJson: string, args: OnDeviceLlmOptions): Promise<string>;
  contextSize(): Promise<number | null>;
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
    super(`On-device built-in model call failed (${code})`);
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
  'needsSystemUpdate',
];

/** Which built-in model this platform has, if the native module is present. */
export function platformModel(): 'afm' | 'nano' | null {
  if (!resolveNative()) return null;
  if (Platform.OS === 'ios') return 'afm';
  if (Platform.OS === 'android') return 'nano';
  return null;
}

/** The built-in model's context window in tokens (input plus output), or null when unknown. */
export async function contextSize(): Promise<number | null> {
  const native = resolveNative();
  if (!native) return null;
  try {
    const n = await native.contextSize();
    return typeof n === 'number' && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Whether the built-in model can run now, for Mera's app language. */
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

/**
 * A reply shaped by `schemaJson` (a JSON Schema subset: object, string with enum,
 * integer, number, boolean, array). Resolves to JSON TEXT: guided generation on
 * Apple, plain text on Android, so the caller still extracts and validates it.
 */
export async function respondStructured(
  instructions: string,
  prompt: string,
  schemaJson: string,
  options: OnDeviceLlmOptions = {},
): Promise<string> {
  const native = resolveNative();
  if (!native) throw new OnDeviceLlmError('ERR_AFM_UNAVAILABLE');
  try {
    return await native.respondStructured(instructions, prompt, schemaJson, options);
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
