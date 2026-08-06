// Static, non-identifying build/device facts, shared by BOTH observability
// destinations: Sentry tags (lib/observability/sentry-scope.ts) and RevenueCat
// subscriber attributes (lib/revenuecat.ts).
//
// The point of a single module is the shared VOCABULARY. `app_version` and
// `ota_update_id` mean the same thing and carry byte-identical values in both
// systems, which is what makes "this bad JS bundle correlates with that revenue
// dip" answerable without joining anything per-user.
//
// PRIVACY CONTRACT — read before adding a field.
// Every value here must be a BUILD or DEVICE fact shared by many users. Nothing
// derived from persona facts, topics, interests, locations, or reading history
// may enter this module or either destination. That is the product's core
// invariant (no collection links a user to a topic), and privacy-policy §3.5
// states we do not collect article-level behaviour. A field with no named
// support/debugging purpose does not belong here either.
//
// This file must NOT import any store or app module — lib/sentry-init.ts
// imports it, and that file is deliberately the first import in the app
// (app/_layout.tsx:4) so a later module-load throw is still captured. Anything
// runtime-varying lives in ./runtime-context.ts instead.

import * as Application from 'expo-application';
import * as Device from 'expo-device';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';

/**
 * The on-device-model RAM minimum, 6 GB. Deliberately reuses the boundary
 * already established in lib/mera-protocol-toolkit/core/systemRequirements.ts
 * (`MIN_RAM_BYTES`) and lib/stores/display-prefs-store.ts (`LOW_MEMORY_BYTES`)
 * rather than inventing a third one — a device below it cannot run the local
 * model and renders the animated backdrop badly, which is exactly the split
 * worth seeing in a crash report.
 */
const MODEL_CAPABLE_RAM_BYTES = 6 * 1024 * 1024 * 1024;

export type DeviceTier = 'low' | 'high' | 'unknown';

/** Bucketed, so it describes a class of device rather than fingerprinting one. */
function deviceTier(): DeviceTier {
  const total = Device.totalMemory;
  // `null` means "couldn't determine" and must NOT be read as "low".
  if (typeof total !== 'number' || total <= 0) return 'unknown';
  return total < MODEL_CAPABLE_RAM_BYTES ? 'low' : 'high';
}

export interface StaticAppContext {
  app_version: string;
  app_build: string;
  platform: string;
  os_version: string;
  device_tier: DeviceTier;
  /**
   * The single highest-value triage field. We ship OTA updates constantly and
   * Sentry cannot derive which JS bundle was running — `release` only tracks
   * the native build. Without this, an OTA-introduced crash is unattributable.
   */
  ota_update_id: string;
  ota_channel: string;
  runtime_version: string;
  is_embedded_launch: boolean;
}

// Every value below is fixed for the lifetime of the process, so this is
// computed once. Recomputing per event would cost a native bridge read on
// `Device.totalMemory` for a value that cannot have changed.
let cached: StaticAppContext | null = null;

export function getStaticAppContext(): StaticAppContext {
  if (cached) return cached;
  cached = {
    app_version: Application.nativeApplicationVersion ?? 'unknown',
    app_build: Application.nativeBuildVersion ?? 'unknown',
    platform: Platform.OS,
    os_version: String(Platform.Version),
    device_tier: deviceTier(),
    // `updateId` is null on an embedded (store-installed, not yet OTA'd)
    // launch — 'embedded' is more useful in a tag filter than an empty value.
    ota_update_id: Updates.updateId ?? 'embedded',
    ota_channel: Updates.channel ?? 'embedded',
    runtime_version: Updates.runtimeVersion ?? 'unknown',
    is_embedded_launch: Updates.isEmbeddedLaunch,
  };
  return cached;
}

/** Test seam — the module-level cache would otherwise leak across test cases. */
export function resetStaticAppContextCache(): void {
  cached = null;
}
