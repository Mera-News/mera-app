// Lite mode: ONE switch for every optional visual cost (animated backdrop,
// looping scenes, card arrival motion, decorative logo loops), replacing the
// separate "Static background" setting.
//
// The friction it removes: the system-check screen has to tell a reader, in
// one line, how the app will run on their phone, and Settings has to let them
// change that in one place. A per-effect switch cannot answer either.
//
// DEVICE-LEVEL, NOT ACCOUNT-LEVEL. The override lives in AsyncStorage, not the
// WatermelonDB `settings` table: an account switch runs `unsafeResetDatabase`,
// which would silently re-derive a reader's explicit choice on a phone that
// did not change. `lib/security/local-wipe.ts` removes only its own named
// AsyncStorage keys, so this one survives a wipe by design.
//
// The default is re-derived from the device on every launch, so only an
// explicit choice is ever stored.

import AsyncStorage from '@react-native-async-storage/async-storage';

export type PerformanceMode = 'full' | 'lite';
/** What is stored. `auto` is internal only: "the reader never flipped the
 *  switch, follow the phone". The UI is a plain On/Off switch; the owner
 *  ruled an "Automatic" choice too hard to understand. */
export type PerformanceOverride = 'auto' | PerformanceMode;

export const PERFORMANCE_OVERRIDE_KEY = 'performance_mode_override';

/**
 * Below this much RAM a phone runs Lite by default. The same 6 GB line
 * `lib/mera-protocol-toolkit/core/systemRequirements.ts` uses, and the one the
 * old "Static background" default used, so no reader's app looks different on
 * the day this ships. `expo-device` exposes no CPU or GPU signal, and its
 * Android `deviceYearClass` tops out at 2016, so RAM is the only static signal
 * there is. A measured signal needs a second calibration device first.
 */
export const LITE_BELOW_BYTES = 6 * 1024 * 1024 * 1024;

/** `null` or a non-positive reading means "couldn't determine", which must NOT
 *  read as a weak phone: an unknown device keeps the designed look. */
export function classifyDevice(totalMemory: number | null | undefined): PerformanceMode {
    return typeof totalMemory === 'number' && totalMemory > 0 && totalMemory < LITE_BELOW_BYTES ? 'lite' : 'full';
}

export function resolvePerformanceMode(override: PerformanceOverride, deviceMode: PerformanceMode): PerformanceMode {
    return override === 'auto' ? deviceMode : override;
}

function isOverride(value: unknown): value is PerformanceOverride {
    return value === 'auto' || value === 'full' || value === 'lite';
}

export async function readPerformanceOverride(): Promise<PerformanceOverride | null> {
    const raw = await AsyncStorage.getItem(PERFORMANCE_OVERRIDE_KEY);
    return isOverride(raw) ? raw : null;
}

export async function writePerformanceOverride(value: PerformanceOverride): Promise<void> {
    await AsyncStorage.setItem(PERFORMANCE_OVERRIDE_KEY, value);
}

/**
 * The old "Static background" row stored '1' (static) or '0' (animated) in the
 * `settings` table. An explicit choice there maps onto the new switch once;
 * no row means the reader never chose, which is `auto`.
 */
export function overrideFromLegacyStaticGradient(raw: string | null): PerformanceOverride {
    if (raw === '1') return 'lite';
    if (raw === '0') return 'full';
    return 'auto';
}
