// The on-device TEXT engine: the platform's built-in model, which writes chat,
// notes, topics, persona summaries and story headlines in On this phone mode.
//
//   'afm'   Apple Foundation Models (Apple Intelligence), iOS 26+.
//   'nano'  Gemini Nano (ML Kit GenAI Prompt API), Android.
//
// Both run in modules/mera-on-device-llm, out of process. A phone only ever has
// one, so there is nothing to choose or store (D37). Relevance and the chat
// decisions run on Kev, the downloaded relevance model.

import { Platform } from 'react-native';
import {
  availability as onDeviceLlmAvailability,
  platformModel,
  type OnDeviceLlmAvailability,
  type OnDeviceLlmUnavailableReason,
} from '@/modules/mera-on-device-llm';
import type { TextEngine } from '../types';

export type { TextEngine };

/** The row of the retired text-engine choice. Never read; swept once at boot. */
export const RETIRED_TEXT_ENGINE_SETTING = 'mera_text_engine';

/**
 * Why a built-in model can never run on this phone as it is: no such model on
 * this platform, a phone that is not eligible, an OS too old. Every other reason
 * (still downloading, switched off, a language, a pending system update) can be
 * fixed on the phone, so the screen shows it instead of "This phone can't run it".
 */
export const CANNOT_RUN_REASONS: ReadonlySet<OnDeviceLlmUnavailableReason> = new Set([
  'unsupportedPlatform',
  'deviceNotEligible',
  'osTooOld',
]);

/** This phone's built-in model, or null (no native module, or a platform without one). */
export function builtInEngine(): TextEngine | null {
  return platformModel();
}

/**
 * The engine for this phone. With no native module it is still this platform's
 * name: every call then rejects with ERR_AFM_UNAVAILABLE, the one unavailable path.
 */
export async function getTextEngine(): Promise<TextEngine> {
  return platformModel() ?? (Platform.OS === 'android' ? 'nano' : 'afm');
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
 * Platforms where On this phone is offered during the beta (owner, 2026-10-20:
 * iOS only for now). The Gemini Nano module still ships; adding 'android' here
 * turns it on.
 */
export const ON_DEVICE_BETA_PLATFORMS: ReadonlySet<string> = new Set(['ios']);

/**
 * Whether the platform's built-in model can run now, with the reason when it
 * cannot. Never cached: it can be switched on, or finish downloading, while the
 * app runs. Cheap enough to call on every focus. A platform outside the beta
 * reads as having no built-in model, so every gate (the requirements check, the
 * screen, the Feed pill, the reading meter) says this phone cannot run it.
 */
export function builtInAvailability(): Promise<OnDeviceLlmAvailability> {
  if (!ON_DEVICE_BETA_PLATFORMS.has(Platform.OS)) {
    return Promise.resolve({ available: false, reason: 'unsupportedPlatform' });
  }
  return onDeviceLlmAvailability(appLanguage());
}
