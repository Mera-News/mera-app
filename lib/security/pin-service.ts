// Local 4-digit PIN gate. OTP login identifies the user ONCE; thereafter app
// access is protected by this PIN, which lives only on-device (never sent to a
// server). Storage is the same secure-store adapter used for auth tokens
// (AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY), so the record survives reinstalls of
// the JS bundle but stays off iCloud Keychain sync and off other devices.
//
// Hashing: scrypt from @noble/hashes (already a dep via lib/e2ee). Params
// N=2^15 (32 MiB), r=8, p=1 are the moderate end for a phone — a few tens of
// ms per hash on an iPhone 15 Pro, heavy enough to make an offline brute force
// of a 4-digit space (10k candidates) cost real wall-clock time, light enough
// not to jank the setup/unlock flow. We run the async variant so the KDF never
// blocks the JS thread. Attempt-limiting (below) is the primary defense; the
// KDF cost is defense-in-depth for an attacker who extracts the record.

import { scryptAsync } from '@noble/hashes/scrypt.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import Constants from 'expo-constants';
import { secureStore } from '../utils/secure-store-adapter';
import logger from '../logger';

const APP_SLUG = Constants.expoConfig?.slug || 'app';
const PIN_RECORD_KEY = `${APP_SLUG}_pin_record`;
const PIN_ATTEMPTS_KEY = `${APP_SLUG}_pin_attempts`;

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 } as const;
const SALT_LEN = 16;

// Escalating cooldown thresholds. Every wrong attempt increments failCount;
// each time it crosses a multiple of 5 we impose the corresponding lockout.
const COOLDOWN_STEP = 5;
const COOLDOWN_30S = 30_000;
const COOLDOWN_60S = 60_000;
const COOLDOWN_5MIN = 5 * 60_000;

interface PinRecord {
  saltHex: string;
  hashHex: string;
  createdAt: number;
}

interface AttemptState {
  failCount: number;
  /** epoch ms until which entry is locked out (0 = not locked). */
  lockedUntil: number;
}

export interface PinVerifyResult {
  success: boolean;
  /** epoch ms the cooldown lifts, when currently locked out. */
  lockedUntil?: number;
  /** convenience: ms remaining on the current cooldown. */
  remainingMs?: number;
  /** total consecutive failures so far. */
  failCount?: number;
}

async function hashPin(pin: string, salt: Uint8Array): Promise<string> {
  const derived = await scryptAsync(utf8ToBytes(pin), salt, SCRYPT_PARAMS);
  return bytesToHex(derived);
}

async function readRecord(): Promise<PinRecord | null> {
  try {
    const raw = await secureStore.getItemAsync(PIN_RECORD_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PinRecord;
  } catch (err) {
    logger.captureException(err, { tags: { service: 'pin-service', method: 'readRecord' } });
    return null;
  }
}

async function readAttempts(): Promise<AttemptState> {
  try {
    const raw = await secureStore.getItemAsync(PIN_ATTEMPTS_KEY);
    if (!raw) return { failCount: 0, lockedUntil: 0 };
    const parsed = JSON.parse(raw) as Partial<AttemptState>;
    return {
      failCount: parsed.failCount ?? 0,
      lockedUntil: parsed.lockedUntil ?? 0,
    };
  } catch {
    return { failCount: 0, lockedUntil: 0 };
  }
}

async function writeAttempts(state: AttemptState): Promise<void> {
  try {
    await secureStore.setItemAsync(PIN_ATTEMPTS_KEY, JSON.stringify(state));
  } catch (err) {
    logger.captureException(err, { tags: { service: 'pin-service', method: 'writeAttempts' } });
  }
}

async function resetAttempts(): Promise<void> {
  try {
    await secureStore.deleteItemAsync(PIN_ATTEMPTS_KEY);
  } catch {
    // ignore — absence is the desired state
  }
}

/**
 * Cooldown to impose given the *new* total failCount. Returns 0 unless
 * failCount just landed on a COOLDOWN_STEP boundary.
 *   5  → 30s, 10 → 60s, 15+ → 5min (and every 5 thereafter).
 */
export function cooldownForFailCount(failCount: number): number {
  if (failCount === 0 || failCount % COOLDOWN_STEP !== 0) return 0;
  if (failCount >= 15) return COOLDOWN_5MIN;
  if (failCount >= 10) return COOLDOWN_60S;
  return COOLDOWN_30S;
}

export async function isPinSet(): Promise<boolean> {
  return (await readRecord()) !== null;
}

export async function setPin(pin: string): Promise<void> {
  const salt = randomBytes(SALT_LEN);
  const hashHex = await hashPin(pin, salt);
  const record: PinRecord = {
    saltHex: bytesToHex(salt),
    hashHex,
    createdAt: Date.now(),
  };
  await secureStore.setItemAsync(PIN_RECORD_KEY, JSON.stringify(record));
  await resetAttempts();
}

/**
 * Verifies a PIN attempt, honoring the escalating lockout. On success, resets
 * the attempt state. On failure, increments failCount and — on every 5th miss —
 * arms the next cooldown. Attempt state is persisted so relaunching the app
 * can't reset the counter.
 */
export async function verifyPin(pin: string): Promise<PinVerifyResult> {
  const now = Date.now();
  const attempts = await readAttempts();

  // Currently locked out — reject without spending a hash or an attempt.
  if (attempts.lockedUntil > now) {
    return {
      success: false,
      lockedUntil: attempts.lockedUntil,
      remainingMs: attempts.lockedUntil - now,
      failCount: attempts.failCount,
    };
  }

  const record = await readRecord();
  if (!record) {
    // No PIN configured — treat as failure but don't lock (caller shouldn't
    // reach here; the gate routes PIN-less users to setup).
    return { success: false, failCount: attempts.failCount };
  }

  const candidate = await hashPin(pin, hexToBytes(record.saltHex));
  if (candidate === record.hashHex) {
    await resetAttempts();
    return { success: true, failCount: 0 };
  }

  const failCount = attempts.failCount + 1;
  const cooldown = cooldownForFailCount(failCount);
  const lockedUntil = cooldown > 0 ? now + cooldown : 0;
  await writeAttempts({ failCount, lockedUntil });

  return {
    success: false,
    failCount,
    lockedUntil: lockedUntil || undefined,
    remainingMs: lockedUntil ? lockedUntil - now : undefined,
  };
}

export async function changePin(
  currentPin: string,
  newPin: string,
): Promise<{ success: boolean; result?: PinVerifyResult }> {
  const result = await verifyPin(currentPin);
  if (!result.success) return { success: false, result };
  await setPin(newPin);
  return { success: true };
}

export async function clearPin(): Promise<void> {
  try {
    await secureStore.deleteItemAsync(PIN_RECORD_KEY);
  } catch {
    // ignore
  }
  await resetAttempts();
}

/**
 * ms remaining on any active lockout (0 if entry is currently allowed).
 * Lets the lock screen render the countdown immediately on mount.
 */
export async function getCooldownRemainingMs(): Promise<number> {
  const attempts = await readAttempts();
  const remaining = attempts.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}
