// The on-device TEXT engine: which model writes chat, notes, topics, persona
// summaries and story headlines in On this phone mode.
//
//   'qwen'  the downloaded text model (TEXT_MODEL, run by llama.rn).
//   'afm'   Apple Foundation Models (Apple Intelligence), iOS 26+.
//   'nano'  Gemini Nano (ML Kit GenAI Prompt API), Android.
// The last two are the platform's built-in model (modules/mera-on-device-llm);
// a phone only ever has one of them.
//
// Relevance always runs on the downloaded relevance model, whatever this says.
// The choice lives in its own settings row, read once into a mirror and written
// through, so the Zustand store needs no field and no migration. Rows from the
// earlier build read as: 'mera' -> 'qwen', 'native' -> this platform's built-in.
//
// With no row the engine is derived, never stored (D34): the downloaded text
// model when its file is on disk, else the built-in model when it can run now,
// else 'qwen'. A derived value is re-derived on every read, so a download that
// lands or a built-in model that becomes ready changes it.

import { useSyncExternalStore } from 'react';
import {
  availability as onDeviceLlmAvailability,
  platformModel,
  type OnDeviceLlmAvailability,
} from '@/modules/mera-on-device-llm';
import { TEXT_MODEL } from './model-catalog';

export type TextEngine = 'qwen' | 'afm' | 'nano';
export type BuiltInEngine = Exclude<TextEngine, 'qwen'>;

export const TEXT_ENGINE_SETTING = 'mera_text_engine';
/** The engine when nothing better is known: the downloaded text model. */
export const DEFAULT_TEXT_ENGINE: TextEngine = 'qwen';

/** The stored row, parsed; null when there is none. */
let stored: TextEngine | null = null;
let rowRead = false;
/** What the last read resolved to, for sync callers. */
let mirror: TextEngine | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

export function isBuiltInEngine(engine: TextEngine): engine is BuiltInEngine {
  return engine !== 'qwen';
}

/** This phone's built-in model, or null (no native module, or a platform without one). */
export function builtInEngine(): BuiltInEngine | null {
  return platformModel();
}

/** A stored row as an engine. Old values migrate; anything unknown is no choice. */
function parseRow(row: string | null | undefined): TextEngine | null {
  switch (row) {
    case 'qwen':
    case 'mera':
      return 'qwen';
    case 'afm':
    case 'nano':
      // A row from the other platform (a restored backup) means "the built-in model".
      return builtInEngine() ?? row;
    case 'native':
      return builtInEngine();
    default:
      return null;
  }
}

/* eslint-disable @typescript-eslint/no-require-imports */
// Lazy: the setting service builds its collection at module scope, and this
// module is in the graph of everything that imports the toolkit. modelManager
// imports this module, so it is required lazily too.
function settingService(): typeof import('@/lib/database/services/setting-service') {
  return require('@/lib/database/services/setting-service');
}
function modelManager(): typeof import('./modelManager') {
  return require('./modelManager');
}
/* eslint-enable @typescript-eslint/no-require-imports */

async function derivedEngine(): Promise<TextEngine> {
  try {
    if (await modelManager().isModelDownloaded(TEXT_MODEL.modelId)) return 'qwen';
  } catch {
    // An unreadable manifest is "not on disk".
  }
  const builtIn = builtInEngine();
  if (builtIn && (await builtInAvailability()).available) return builtIn;
  return DEFAULT_TEXT_ENGINE;
}

/** The engine in force: the stored choice, else the derived default. */
export async function getTextEngine(): Promise<TextEngine> {
  if (!rowRead) {
    try {
      stored = parseRow(await settingService().getSetting(TEXT_ENGINE_SETTING));
    } catch {
      stored = null;
    }
    rowRead = true;
  }
  const engine = stored ?? (await derivedEngine());
  if (engine !== mirror) {
    mirror = engine;
    emit();
  }
  return engine;
}

/** The engine as last read, for sync callers (UI); the default before the first read. */
export function peekTextEngine(): TextEngine {
  return mirror ?? stored ?? DEFAULT_TEXT_ENGINE;
}

/** Stores the choice. The mirror changes at once; the row write is awaited. */
export async function setTextEngine(engine: TextEngine): Promise<void> {
  stored = engine;
  rowRead = true;
  mirror = engine;
  emit();
  await settingService().setSetting(TEXT_ENGINE_SETTING, engine);
}

/** The engine, live. Call `getTextEngine()` once (on mount) to load it. */
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
 * Whether the platform's built-in model can run now, with the reason when it
 * cannot. Never cached: it can be switched on, or finish downloading, while the
 * app runs. Cheap enough to call on every focus.
 */
export function builtInAvailability(): Promise<OnDeviceLlmAvailability> {
  return onDeviceLlmAvailability(appLanguage());
}

/** Test seam. */
export function __resetTextEngineForTests(): void {
  stored = null;
  rowRead = false;
  mirror = null;
  emit();
}
