// The on-device TEXT engine: which model writes chat, notes, topics, persona
// summaries and story headlines in On this phone mode.
//
//   'mera'    the downloaded text model (TEXT_MODEL, run by llama.rn).
//   'native'  the platform's own on-device model: Apple Foundation Models on
//             iOS 26+ (modules/mera-on-device-llm). Unavailable on Android.
//
// Relevance always runs on the downloaded relevance model, whatever this says.
// The choice lives in its own settings row (default 'mera'), read once into a
// mirror and written through, so the Zustand store needs no field and no
// migration. User-facing copy never names a model (owner rule): the values are
// 'mera' (Mera AI models) and 'native' (this phone's built-in AI).

import { useSyncExternalStore } from 'react';
import {
  availability as onDeviceLlmAvailability,
  type OnDeviceLlmAvailability,
} from '@/modules/mera-on-device-llm';

export type TextEngine = 'mera' | 'native';

export const TEXT_ENGINE_SETTING = 'mera_text_engine';
export const DEFAULT_TEXT_ENGINE: TextEngine = 'mera';

let cached: TextEngine | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

/* eslint-disable @typescript-eslint/no-require-imports */
// Lazy: the setting service builds its collection at module scope, and this
// module is in the graph of everything that imports the toolkit.
function settingService(): typeof import('@/lib/database/services/setting-service') {
  return require('@/lib/database/services/setting-service');
}
/* eslint-enable @typescript-eslint/no-require-imports */

/** The stored choice. Reads the row once per process; an unreadable row is the default. */
export async function getTextEngine(): Promise<TextEngine> {
  if (cached) return cached;
  try {
    const row = await settingService().getSetting(TEXT_ENGINE_SETTING);
    cached = row === 'native' ? 'native' : DEFAULT_TEXT_ENGINE;
  } catch {
    cached = DEFAULT_TEXT_ENGINE;
  }
  emit();
  return cached;
}

/** The choice as last read, for sync callers (UI); the default before the first read. */
export function peekTextEngine(): TextEngine {
  return cached ?? DEFAULT_TEXT_ENGINE;
}

/** Stores the choice. The mirror changes at once; the row write is awaited. */
export async function setTextEngine(engine: TextEngine): Promise<void> {
  cached = engine;
  emit();
  await settingService().setSetting(TEXT_ENGINE_SETTING, engine);
}

/** The stored choice, live. Call `getTextEngine()` once (on mount) to load it. */
export function useTextEngine(): TextEngine {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    peekTextEngine,
    peekTextEngine,
  );
}

/** Mera's in-app language, which can differ from the device locale. */
function appLanguage(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useAppLanguageStore } = require('@/lib/stores/app-language-store') as typeof import('@/lib/stores/app-language-store');
    return useAppLanguageStore.getState().appLanguage || 'en';
  } catch {
    return 'en';
  }
}

/**
 * Whether the platform's on-device model can run now, with the reason when it
 * cannot. Never cached: Apple Intelligence can be switched on, or its model can
 * finish downloading, while the app runs. Cheap enough to call on every focus.
 */
export function nativeEngineAvailability(): Promise<OnDeviceLlmAvailability> {
  return onDeviceLlmAvailability(appLanguage());
}

/** Test seam. */
export function __resetTextEngineForTests(): void {
  cached = null;
  emit();
}
