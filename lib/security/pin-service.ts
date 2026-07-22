// Local 4-digit PIN gate. OTP login identifies the user ONCE; thereafter app
// access is protected by this PIN, which lives only on-device (never sent to a
// server). Storage is the same secure-store adapter used for auth tokens
// (AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY), so the record survives reinstalls of
// the JS bundle but stays off iCloud Keychain sync and off other devices.
//
// Hashing: salted SHA-256 via expo-crypto's native digest (digestStringAsync).
// We previously used scrypt from @noble/hashes, a memory-hard KDF meant to
// slow down brute forcing of high-entropy secrets. That's the wrong tool
// here: the candidate space is a 4-digit PIN (10k values), and it ran as
// pure JS on Hermes (no native scrypt binding), which took on the order of
// SECONDS per hash at the N=2^15 params we had — that was the entire cause
// of the multi-second delay users saw after entering a PIN (see the
// [pin-timing] logs below). A memory-hard KDF adds nothing over a 10k-value
// space that a native digest doesn't already cover cheaply: the real
// defenses are (a) the record living in the OS keychain, off-device and
// inaccessible without extracting the app's secure storage, and (b) the
// escalating cooldown in verifyPin, which makes online brute forcing
// infeasible regardless of hash speed. A fast native SHA-256 keeps offline
// guessing non-trivial (attacker needs the keychain extract first) without
// taxing the JS thread at all. `algo` on PinRecord is the upgrade path if
// this ever needs revisiting — verifyPin/isPinSet treat any record whose
// algo doesn't match the current one as unusable (see below) rather than
// trying to interpret it under the wrong scheme.

import * as Crypto from 'expo-crypto';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import Constants from 'expo-constants';
import { secureStore } from '../utils/secure-store-adapter';
import logger from '../logger';

const APP_SLUG = Constants.expoConfig?.slug || 'app';
const PIN_RECORD_KEY = `${APP_SLUG}_pin_record`;
const PIN_ATTEMPTS_KEY = `${APP_SLUG}_pin_attempts`;

const PIN_ALGO = 'sha256-v1' as const;
const SALT_LEN = 16;

// Escalating cooldown thresholds. Every wrong attempt increments failCount;
// each time it crosses a multiple of 5 we impose the corresponding lockout.
const COOLDOWN_STEP = 5;
const COOLDOWN_30S = 30_000;
const COOLDOWN_60S = 60_000;
const COOLDOWN_5MIN = 5 * 60_000;

interface PinRecord {
  /** KDF/format identity. Records without a matching algo are treated as
   *  unusable rather than run through the current hashPin (see file header). */
  algo: typeof PIN_ALGO;
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

async function hashPin(pin: string, saltHex: string): Promise<string> {
  const start = Date.now();
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `${saltHex}:${pin}`,
  );
  logger.info(`[pin-timing] hashPin sha256=${Date.now() - start}ms`);
  return digest;
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

// An algo-mismatched record (e.g. a scrypt-era record from before the
// sha256-v1 migration, only ever possible on dev devices — this feature is
// unreleased) can never be verified under the current hashPin. Rather than
// let that manifest as an unverifiable, un-clearable lockout, we treat it
// identically to "no PIN set": isPinSet() returns false, which routes the
// launch gate to PIN setup, and the resulting setPin() call overwrites the
// stale record with a current-algo one. Self-healing, no dedicated recovery
// UX needed.
function isUsableRecord(record: PinRecord): boolean {
  return record.algo === PIN_ALGO;
}

export async function isPinSet(): Promise<boolean> {
  const start = Date.now();
  const record = await readRecord();
  const result = record !== null && isUsableRecord(record);
  logger.info(`[pin-timing] isPinSet read=${Date.now() - start}ms result=${result}`);
  return result;
}

export async function setPin(pin: string): Promise<void> {
  const totalStart = Date.now();
  const saltHex = bytesToHex(randomBytes(SALT_LEN));

  const hashStart = Date.now();
  const hashHex = await hashPin(pin, saltHex);
  const hashMs = Date.now() - hashStart;

  const record: PinRecord = {
    algo: PIN_ALGO,
    saltHex,
    hashHex,
    createdAt: Date.now(),
  };

  const writeStart = Date.now();
  await secureStore.setItemAsync(PIN_RECORD_KEY, JSON.stringify(record));
  const writeMs = Date.now() - writeStart;

  await resetAttempts();

  logger.info(
    `[pin-timing] setPin total=${Date.now() - totalStart}ms hash=${hashMs}ms write=${writeMs}ms`,
  );
}

/**
 * Verifies a PIN attempt, honoring the escalating lockout. On success, resets
 * the attempt state. On failure, increments failCount and — on every 5th miss —
 * arms the next cooldown. Attempt state is persisted so relaunching the app
 * can't reset the counter.
 */
export async function verifyPin(pin: string): Promise<PinVerifyResult> {
  const totalStart = Date.now();
  const now = Date.now();

  const attemptsStart = Date.now();
  const attempts = await readAttempts();
  const attemptsMs = Date.now() - attemptsStart;

  // Currently locked out — reject without spending a hash or an attempt.
  if (attempts.lockedUntil > now) {
    logger.info(
      `[pin-timing] verifyPin total=${Date.now() - totalStart}ms attempts=${attemptsMs}ms record=0ms hash=0ms outcome=lockedOut`,
    );
    return {
      success: false,
      lockedUntil: attempts.lockedUntil,
      remainingMs: attempts.lockedUntil - now,
      failCount: attempts.failCount,
    };
  }

  const recordStart = Date.now();
  const record = await readRecord();
  const recordMs = Date.now() - recordStart;
  if (!record) {
    // No PIN configured — treat as failure but don't lock (caller shouldn't
    // reach here; the gate routes PIN-less users to setup).
    logger.info(
      `[pin-timing] verifyPin total=${Date.now() - totalStart}ms attempts=${attemptsMs}ms record=${recordMs}ms hash=0ms outcome=noRecord`,
    );
    return { success: false, failCount: attempts.failCount };
  }

  if (!isUsableRecord(record)) {
    // Legacy (pre sha256-v1) record — can never be verified under the
    // current hashPin. Don't burn an attempt or arm a cooldown against a
    // record nobody can satisfy; isPinSet() already treats this the same as
    // "no PIN set" so the caller should self-heal via PIN setup.
    logger.info('[pin-timing] legacy record, algo mismatch');
    logger.info(
      `[pin-timing] verifyPin total=${Date.now() - totalStart}ms attempts=${attemptsMs}ms record=${recordMs}ms hash=0ms outcome=legacyAlgoMismatch`,
    );
    return { success: false, failCount: attempts.failCount };
  }

  const hashStart = Date.now();
  const candidate = await hashPin(pin, record.saltHex);
  const hashMs = Date.now() - hashStart;

  if (candidate === record.hashHex) {
    await resetAttempts();
    logger.info(
      `[pin-timing] verifyPin total=${Date.now() - totalStart}ms attempts=${attemptsMs}ms record=${recordMs}ms hash=${hashMs}ms outcome=success`,
    );
    return { success: true, failCount: 0 };
  }

  const failCount = attempts.failCount + 1;
  const cooldown = cooldownForFailCount(failCount);
  const lockedUntil = cooldown > 0 ? now + cooldown : 0;
  await writeAttempts({ failCount, lockedUntil });

  logger.info(
    `[pin-timing] verifyPin total=${Date.now() - totalStart}ms attempts=${attemptsMs}ms record=${recordMs}ms hash=${hashMs}ms outcome=wrongPin`,
  );
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
  const totalStart = Date.now();
  const result = await verifyPin(currentPin);
  if (!result.success) {
    logger.info(
      `[pin-timing] changePin total=${Date.now() - totalStart}ms outcome=verifyFailed note=verify+set(only verify ran, one hash)`,
    );
    return { success: false, result };
  }
  await setPin(newPin);
  logger.info(
    `[pin-timing] changePin total=${Date.now() - totalStart}ms outcome=success note=verify+set(two hashes)`,
  );
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
