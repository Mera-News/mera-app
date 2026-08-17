// Device sign-in orchestration: App Attest (iOS) / Play Integrity (Android)
// minting a Better Auth session, per the auth-wave contract
// (docs/auth-migration-plan.md, "Continuous execution" section).
//
// Every route below lives under the Better Auth basePath on the auth service
// and is called through `authClient.$fetch`, so the expo client's cookie
// persistence applies to the minted session with zero extra transport work —
// the same reason the email OTP flow needs none.
//
// Shape rules this module holds:
//  - A nonce is single-use and server-generated. EVERY attempt starts by
//    fetching a fresh one; a retry never resubmits an old nonce (it would be a
//    guaranteed 400 that looks like a permanent failure).
//  - The App Attest keyId is stored ONLY after the server accepted the
//    attestation. Storing it earlier would wedge the device on a key the
//    server never saw.
//  - A stored keyId that the OS reports invalid (ERR_ATTEST_INVALID_KEY — the
//    key does not survive reinstall/restore) is cleared and enrollment restarts
//    from generateKey, once per call.
//  - A keychain READ failure is not "no key". Treating a locked keychain as
//    absent would enroll a second key and mint a second account while the
//    user's real account stays bound to the first — so a read rejection aborts
//    the attempt as retryable instead. Same distinction secure-store-adapter.ts
//    documents.
//  - Never throws: every outcome is a typed result the UI can render.
//
// Hashing convention, shared with the server implementation: SHA256 over the
// UTF-8 bytes of the base64url nonce string — for BOTH the attest challenge
// and the assertion clientDataHash. Per the final S2 contract the nonce IS the
// client data; the HTTP bodies carry the raw nonce string and the hashing
// happens only on the way into the native calls.

import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

import {
  attestKey,
  generateAssertion,
  generateKey,
  isInvalidKeyError,
  isSupported,
  requestIntegrityToken,
} from '@/modules/mera-device-attest';
import { authClient } from '@/lib/auth-client';
import logger from '@/lib/logger';
import { secureStore } from '@/lib/utils/secure-store-adapter';

const APP_SLUG = Constants.expoConfig?.slug || 'app';

/** Keychain slot for the server-accepted App Attest keyId. Cleared on logout
 *  (lib/security/local-wipe.ts) so the next person on the device mints a fresh
 *  account instead of resuming this one. */
export const APP_ATTEST_KEY_ID_STORE_KEY = `${APP_SLUG}_appattest_key_id`;

/** Keychain slot for the stable random deviceId. Required by the Android
 *  sign-in (Play Integrity verdicts carry no device identity, so this is the
 *  resume key) and by the staging dev bypass. */
export const DEVICE_ID_STORE_KEY = `${APP_SLUG}_device_attest_device_id`;

// Read at call time, not module scope: Metro inlines EXPO_PUBLIC_* wherever it
// appears, and call-time reads keep the module testable without resetModules.
function readDevBypassToken(): string {
  return process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN || '';
}

function readPlayIntegrityProject(): string | null {
  return process.env.EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT || null;
}

export type DeviceSignInFailureReason =
  /** Server said 400 DEVICE_ATTESTATION_FAILED — the device was refused. */
  | 'attestation-denied'
  /** Server 503, or Apple's attestation CA unreachable. Try again later. */
  | 'attestation-unavailable'
  /** Transport-level failure. Try again. */
  | 'network'
  | 'unknown';

export type DeviceSignInResult =
  | { status: 'success'; userId: string }
  /** No native attestation on this device and no dev bypass configured —
   *  callers route to the email sign-in path. */
  | { status: 'unsupported' }
  /** Every failure is retryable: a retry re-enters the whole flow and fetches
   *  a fresh nonce. */
  | { status: 'failed'; reason: DeviceSignInFailureReason };

export type DeviceSignInAvailability = 'native' | 'dev-bypass' | 'unavailable';

/** What the sign-in screen consults at mount, so an unsupported device renders
 *  the email view instead of a dead CTA. Never rejects. */
export async function deviceSignInAvailability(): Promise<DeviceSignInAvailability> {
  if (await isSupported()) return 'native';
  if (readDevBypassToken()) return 'dev-bypass';
  return 'unavailable';
}

// ─── Server transport ────────────────────────────────────────────────────────

/** A non-2xx response from the auth service, with the body's `code` when the
 *  server sent one. */
class ServerRejection extends Error {
  constructor(
    readonly path: string,
    readonly status: number | undefined,
    readonly code: string | undefined,
  ) {
    super(`Auth service rejected ${path}: ${status ?? '?'} ${code ?? ''}`);
    this.name = 'ServerRejection';
  }
}

interface BetterFetchErrorLike {
  status?: number;
  code?: string;
  message?: string;
}

/** POST through the better-auth client so its cookie persistence applies.
 *  Resolves the parsed body; throws ServerRejection on a server error and
 *  lets transport-level throws (offline, DNS) propagate for classification. */
async function post<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const result = (await authClient.$fetch(path, {
    method: 'POST',
    ...(body ? { body } : {}),
  })) as { data?: T; error?: BetterFetchErrorLike | null };
  if (result?.error) {
    throw new ServerRejection(path, result.error.status, result.error.code);
  }
  return (result?.data ?? (result as unknown)) as T;
}

type NoncePurpose = 'attest' | 'assert' | 'integrity';

async function fetchNonce(purpose: NoncePurpose): Promise<string> {
  const data = await post<{ nonce?: string }>('/device/nonce', { purpose });
  if (!data?.nonce || typeof data.nonce !== 'string') {
    throw new ServerRejection('/device/nonce', undefined, 'MALFORMED_NONCE_RESPONSE');
  }
  return data.nonce;
}

interface SessionResponseLike {
  user?: { id?: string };
}

/** Pull the user id out of a better-auth session response. */
function requireUserId(path: string, data: SessionResponseLike): string {
  const userId = data?.user?.id;
  if (!userId || typeof userId !== 'string') {
    throw new ServerRejection(path, undefined, 'MALFORMED_SESSION_RESPONSE');
  }
  return userId;
}

// ─── Hash and base64 helpers ─────────────────────────────────────────────────

function sha256Base64(input: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
}

// ─── Keychain-backed state ───────────────────────────────────────────────────

/** Distinguishes "no key stored" (null) from "keychain unreadable" (throws). */
function readStoredKeyId(): Promise<string | null> {
  return secureStore.getItemAsync(APP_ATTEST_KEY_ID_STORE_KEY);
}

async function clearStoredKeyId(): Promise<void> {
  try {
    await secureStore.deleteItemAsync(APP_ATTEST_KEY_ID_STORE_KEY);
  } catch {
    // A failed delete only means the next attempt retries the same recovery.
  }
}

async function readOrCreateDeviceId(): Promise<string> {
  const existing = await secureStore.getItemAsync(DEVICE_ID_STORE_KEY).catch(() => null);
  if (existing) return existing;
  const fresh = Crypto.randomUUID();
  try {
    await secureStore.setItemAsync(DEVICE_ID_STORE_KEY, fresh);
  } catch {
    // Persisting failed — the id is still usable for this attempt; the next
    // attempt mints another, which at worst resumes a different (empty)
    // account until the keychain heals.
  }
  return fresh;
}

// ─── Platform flows ──────────────────────────────────────────────────────────

/** First-time iOS enrollment: nonce → generateKey → attestKey(sha256(nonce))
 *  → POST attest/ios. The keyId is persisted only after the server accepted. */
async function enrollIos(): Promise<string> {
  const nonce = await fetchNonce('attest');
  const keyId = await generateKey();
  const challenge = await sha256Base64(nonce);
  const attestation = await attestKey(keyId, challenge);
  await post('/device/attest/ios', { keyId, attestation, nonce });
  // Deliberately unguarded: the server accepted this key, so a failed persist
  // must abort the attempt as retryable rather than continue to a sign-in
  // whose key the next attempt cannot find.
  await secureStore.setItemAsync(APP_ATTEST_KEY_ID_STORE_KEY, keyId);
  return keyId;
}

/** Fresh nonce → assertion over the nonce → POST sign-in/ios. The nonce IS
 *  the client data (final S2 contract): the body carries it raw, and only the
 *  native call receives its hash. */
async function assertAndSignInIos(keyId: string): Promise<string> {
  const nonce = await fetchNonce('assert');
  const clientDataHash = await sha256Base64(nonce);
  const assertion = await generateAssertion(keyId, clientDataHash);
  const data = await post<SessionResponseLike>('/device/sign-in/ios', {
    keyId,
    assertion,
    nonce,
  });
  return requireUserId('/device/sign-in/ios', data);
}

async function signInIos(): Promise<string> {
  const storedKeyId = await readStoredKeyId();
  if (!storedKeyId) {
    const keyId = await enrollIos();
    return assertAndSignInIos(keyId);
  }
  try {
    return await assertAndSignInIos(storedKeyId);
  } catch (error) {
    // The stored key vanished (reinstall, device migration, restore — App
    // Attest keys survive none of them). Clear it and restart from scratch.
    if (!isInvalidKeyError(error)) throw error;
    await clearStoredKeyId();
    const keyId = await enrollIos();
    return assertAndSignInIos(keyId);
  }
}

async function signInAndroid(): Promise<string> {
  const nonce = await fetchNonce('integrity');
  const integrityToken = await requestIntegrityToken(nonce, readPlayIntegrityProject());
  // deviceId is REQUIRED here: Play Integrity verdicts carry no device
  // identity, so this stable UUID is what the server resumes an account by.
  const deviceId = await readOrCreateDeviceId();
  const data = await post<SessionResponseLike>('/device/sign-in/android', {
    integrityToken,
    nonce,
    deviceId,
  });
  return requireUserId('/device/sign-in/android', data);
}

/** Staging-only bypass: the route exists only where the server has
 *  DEVICE_ATTESTATION_DEV_BYPASS_TOKEN set (404 elsewhere). */
async function signInDev(token: string): Promise<string> {
  const deviceId = await readOrCreateDeviceId();
  const data = await post<SessionResponseLike>('/device/sign-in/dev', { token, deviceId });
  return requireUserId('/device/sign-in/dev', data);
}

// ─── Classification ──────────────────────────────────────────────────────────

function classifyFailure(error: unknown): DeviceSignInResult {
  if (error instanceof ServerRejection) {
    if (error.code === 'DEVICE_ATTESTATION_FAILED') {
      return { status: 'failed', reason: 'attestation-denied' };
    }
    if (error.code === 'DEVICE_ATTESTATION_UNAVAILABLE' || error.status === 503) {
      return { status: 'failed', reason: 'attestation-unavailable' };
    }
    logger.captureMessage('Device sign-in rejected by server', {
      level: 'warning',
      tags: { service: 'device-auth' },
      extra: { path: error.path, status: error.status, code: error.code },
    });
    return { status: 'failed', reason: 'unknown' };
  }

  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ERR_ATTEST_SERVER_UNAVAILABLE') {
    return { status: 'failed', reason: 'attestation-unavailable' };
  }
  if (code === 'ERR_ATTEST_UNSUPPORTED') {
    return { status: 'unsupported' };
  }
  if (error instanceof TypeError) {
    // fetch rejects with TypeError on transport failure (offline, DNS).
    return { status: 'failed', reason: 'network' };
  }

  logger.captureException(error, { tags: { service: 'device-auth' } });
  return { status: 'failed', reason: 'unknown' };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Run the whole device sign-in flow for this platform. Never throws.
 *
 * On success the better-auth cookie is already persisted (the expo client
 * hooks every `$fetch` response); `getSession()` is then fired to nudge the
 * session atom, best-effort — routing must not depend on it, which is why the
 * CALLER records the returned userId via `recordAuthenticatedUser` exactly the
 * way the OTP view does.
 */
export async function signInWithDevice(): Promise<DeviceSignInResult> {
  try {
    const supported = await isSupported();
    let userId: string;
    if (!supported) {
      const token = readDevBypassToken();
      if (!token) return { status: 'unsupported' };
      userId = await signInDev(token);
    } else if (Platform.OS === 'ios') {
      userId = await signInIos();
    } else if (Platform.OS === 'android') {
      userId = await signInAndroid();
    } else {
      return { status: 'unsupported' };
    }

    // Best-effort session-atom refresh. The recorder is what routing trusts.
    void authClient.getSession().catch(() => {});

    return { status: 'success', userId };
  } catch (error) {
    return classifyFailure(error);
  }
}
