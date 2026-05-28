// System Requirements — Device capability checks for on-device LLM inference
// Checks run in priority order and short-circuit on first failure.

import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as RNFS from '@dr.pogodin/react-native-fs';

import type { SystemRequirementsResult, RequirementCheckId } from '../types';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const MIN_RAM_BYTES = 6 * 1024 * 1024 * 1024; // 6 GB
const MIN_IOS_VERSION = 16; // Metal compute shaders
const MIN_ANDROID_API_LEVEL = 29; // Android 10
const MIN_FREE_STORAGE_BYTES = 2.5 * 1024 * 1024 * 1024; // ~2.5 GB for model

// ---------------------------------------------------------------------------
// iOS chip detection
// ---------------------------------------------------------------------------

// Device.modelId returns e.g. "iPhone14,2", "iPhone15,3", "iPad13,1"
// iPhone14,x = A15 chip (iPhone 13 line). We require A15+ for acceptable speed.
const MIN_IPHONE_MAJOR = 14; // iPhone14,x = A15
const MIN_IPAD_MAJOR = 13; // iPad13,x = M1

function checkIOSChip(
  modelId: string | null,
): { supported: boolean; reason: string } {
  if (!modelId) {
    // Cannot determine — allow user to proceed
    return { supported: true, reason: '' };
  }

  const iphoneMatch = modelId.match(/^iPhone(\d+),/);
  if (iphoneMatch) {
    const major = parseInt(iphoneMatch[1], 10);
    if (major < MIN_IPHONE_MAJOR) {
      return {
        supported: false,
        reason: `Requires A15 chip or newer. Your device has an older chip that may be too slow for on-device inference.`,
      };
    }
    return { supported: true, reason: '' };
  }

  const ipadMatch = modelId.match(/^iPad(\d+),/);
  if (ipadMatch) {
    const major = parseInt(ipadMatch[1], 10);
    if (major < MIN_IPAD_MAJOR) {
      return {
        supported: false,
        reason: `Requires M1 chip or newer for iPad. Your device has an older chip.`,
      };
    }
    return { supported: true, reason: '' };
  }

  // Other Apple devices — allow
  return { supported: true, reason: '' };
}

// ---------------------------------------------------------------------------
// Main check function
// ---------------------------------------------------------------------------

export async function checkRequirements(): Promise<SystemRequirementsResult> {
  const platform =
    Platform.OS === 'ios'
      ? 'ios'
      : Platform.OS === 'android'
        ? 'android'
        : 'unknown';

  const totalMem = Device.totalMemory;
  const ramGB =
    totalMem !== null
      ? Math.round((totalMem / (1024 * 1024 * 1024)) * 10) / 10
      : null;
  const osVersion = Device.osVersion;
  const modelId =
    platform === 'ios' ? (Device.modelId as string | null) : null;

  // Storage check (async)
  let freeStorageGB: number | null = null;
  try {
    const fsInfo = await RNFS.getFSInfo();
    freeStorageGB =
      Math.round((fsInfo.freeSpace / (1024 * 1024 * 1024)) * 10) / 10;
  } catch {
    // getFSInfo can fail on some devices — skip storage check
  }

  const deviceInfo = {
    ramGB,
    osVersion,
    platform: platform as 'ios' | 'android' | 'unknown',
    modelId,
    freeStorageGB,
  };

  const fail = (
    reason: string,
    failedCheck: RequirementCheckId,
  ): SystemRequirementsResult => ({
    supported: false,
    reason,
    failedCheck,
    deviceInfo,
  });

  // --- Check 1: RAM ---
  if (totalMem !== null && totalMem < MIN_RAM_BYTES) {
    return fail(
      `Requires at least 6 GB RAM. Your device has ${ramGB} GB.`,
      'ram',
    );
  }

  // --- Check 2: OS Version ---
  if (platform === 'ios' && osVersion) {
    const major = parseInt(osVersion.split('.')[0], 10);
    if (!isNaN(major) && major < MIN_IOS_VERSION) {
      return fail(
        `Requires iOS ${MIN_IOS_VERSION} or later. Your device is running iOS ${osVersion}.`,
        'os_version',
      );
    }
  }
  if (platform === 'android') {
    const apiLevel = Device.platformApiLevel;
    if (apiLevel !== null && apiLevel < MIN_ANDROID_API_LEVEL) {
      return fail(
        `Requires Android 10 or later. Your device is on API level ${apiLevel}.`,
        'os_version',
      );
    }
  }

  // --- Check 3: Chip (iOS only) ---
  // Android: no hard gate — Device.modelId is null, no reliable SoC detection
  if (platform === 'ios') {
    const chipResult = checkIOSChip(modelId);
    if (!chipResult.supported) {
      return fail(chipResult.reason, 'chip');
    }
  }

  // --- Check 4: Storage ---
  if (
    freeStorageGB !== null &&
    freeStorageGB * 1024 * 1024 * 1024 < MIN_FREE_STORAGE_BYTES
  ) {
    return fail(
      `Requires at least 2.5 GB free storage. Your device has ${freeStorageGB} GB free.`,
      'storage',
    );
  }

  // All checks passed
  return {
    supported: true,
    reason: 'All requirements met',
    failedCheck: null,
    deviceInfo,
  };
}
