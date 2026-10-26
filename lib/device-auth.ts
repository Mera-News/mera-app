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
//
// Android binds the deviceId into the Play Integrity nonce (see
// `bindIntegrityNonce`): the token is requested over
// base64url_nopad(SHA-256(utf8(serverNonce + "|" + deviceId))), while the
// body still carries the RAW server nonce and the same deviceId, so the
// server can recompute the value and reject a token lifted onto another
// deviceId.

import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

import {
  attestKey,
  generateAssertion,
  generateKey,
  isIntegrityTransientError,
  isIntegrityUnavailableError,
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

/** Holds the keyId of the last key that COMPLETED a sign-in. A stored key
 *  that never has (enrollment accepted client-side but effectively rejected
 *  or mis-stored server-side) is a "virgin" key: an assert-400 on it severs
 *  and re-enrolls once, where a proven key's 400 stays a plain denial. */
export const APP_ATTEST_KEY_PROVEN_STORE_KEY = `${APP_SLUG}_appattest_key_proven`;

/** Keychain slot for the stable random deviceId. Required by the Android
 *  sign-in (Play Integrity verdicts carry no device identity, so this is the
 *  resume key) and by the staging dev bypass. */
export const DEVICE_ID_STORE_KEY = `${APP_SLUG}_device_attest_device_id`;

/** RETIRED keychain slot: the old server-minted device reference. The app
 *  no longer sends, reads or stores it; `enforceInstallBoundary` deletes it
 *  on launch (lib/security/install-boundary.ts inlines the same string so it
 *  does not import this module). Kept here only so severing also clears a
 *  leftover. */
const RETIRED_DEVICE_REF_STORE_KEY = `${APP_SLUG}_device_ref`;

/** Keychain slot for the TEST account handle this device signs in to (dev
 *  builds with EXPO_PUBLIC_TEST_ACCOUNT_TOKEN only). Severed with the other
 *  device credentials, never by logout or the account-switch wipe. */
export const TEST_ACCOUNT_HANDLE_STORE_KEY = `${APP_SLUG}_test_account_handle`;

/** The server's handle rule, verbatim. The handle is the ONLY way into a test
 *  account: no route takes a user id. */
export const TEST_ACCOUNT_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;

/**
 * Sever this device's ACCOUNT binding. Called on account DELETION
 * (ManageDataScreen) and by the refusal recovery below — never on logout:
 * since S10, sign-out PRESERVES the credentials so logging in resumes the
 * same account. The server also deletes the device record when deletion is
 * requested, so this is the client half of the same severing.
 *
 * Total: a failed delete only means the next attempt repeats the severing.
 * Each failure logs one warn line naming the slot, never its value.
 */
export async function clearDeviceAuthCredentials(): Promise<void> {
  for (const key of [
    APP_ATTEST_KEY_ID_STORE_KEY,
    APP_ATTEST_KEY_PROVEN_STORE_KEY,
    DEVICE_ID_STORE_KEY,
    RETIRED_DEVICE_REF_STORE_KEY,
    TEST_ACCOUNT_HANDLE_STORE_KEY,
  ]) {
    try {
      await secureStore.deleteItemAsync(key);
    } catch (error) {
      // Keychain hiccup — severing is retried by whatever triggered it next.
      logger.warn('[device-auth] could not clear a device credential', {
        slot: key.slice(APP_SLUG.length + 1),
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}

// Read at call time, not module scope: Metro inlines EXPO_PUBLIC_* wherever it
// appears, and call-time reads keep the module testable without resetModules.
// Dev builds only: a release build never takes the bypass, even with the token
// in its env, and a phone that cannot attest shows "not supported" instead.
// When set in a dev build it wins over native attestation (the route exists
// only on a server with DEVICE_ATTESTATION_DEV_BYPASS_TOKEN, i.e. staging).
function readDevBypassToken(): string {
  return __DEV__ ? process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN || '' : '';
}

// Test accounts (staging and prod): DEV BUILDS ONLY, same shape as the dev
// bypass. A release build reads '' here and the minifier drops every branch
// that needs the token, so neither the token nor the route ships.
function readTestAccountToken(): string {
  return __DEV__ ? process.env.EXPO_PUBLIC_TEST_ACCOUNT_TOKEN || '' : '';
}

/** True in a dev build carrying a test-account token. */
export function hasTestAccountToken(): boolean {
  return Boolean(readTestAccountToken());
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
  | {
      status: 'success';
      userId: string;
      /** Server verdict on trial eligibility; null when the response carried
       *  none (older server) — treated as available. */
      /** Mirrors the server field. It has NO CLIENT CONSUMER: the screen that
       *  used to branch on it is deleted, there is no trial to be ineligible
       *  for, and every account holds Starter. Kept because the server still
       *  sends it on every sign-in and it is worth having in a log, not
       *  because anything branches on it. */
      trialAvailable: boolean | null;
      /** True only when this call CREATED the account. A mint owes the new
       *  account a store purchases sync (lib/revenuecat.ts). */
      minted: boolean;
    }
  /** No native attestation on this device and no dev bypass configured.
   *  There is no email fallback for a new user: the phone isn't supported. */
  | { status: 'unsupported' }
  /** Every failure is retryable: a retry re-enters the whole flow and fetches
   *  a fresh nonce. */
  | { status: 'failed'; reason: DeviceSignInFailureReason };

export type DeviceSignInAvailability = 'native' | 'dev-bypass' | 'unavailable';

/** What the sign-in screen consults at mount, so an unsupported device says
 *  so instead of showing a dead CTA. Same order as `signInWithDevice`. Never
 *  rejects. */
export async function deviceSignInAvailability(): Promise<DeviceSignInAvailability> {
  if (readTestAccountToken() || readDevBypassToken()) return 'dev-bypass';
  if (await isSupported()) return 'native';
  return 'unavailable';
}

/**
 * Which attestation path `signInWithDevice` would take on this device. The
 * sign-in copy is keyed on it, because what is TRUE differs per path: only
 * App Attest has Apple checking, only Play Integrity has Google checking,
 * the dev bypass has neither, and the Android UUID fallback (no readable
 * ANDROID_ID) dies with an uninstall where ANDROID_ID survives one.
 * Same decision order as `signInWithDevice`. Never rejects.
 */
export type DeviceSignInPath =
  | 'app-attest'
  | 'play-integrity'
  | 'play-integrity-uuid'
  | 'dev-bypass'
  | 'unavailable';

export async function deviceSignInPath(): Promise<DeviceSignInPath> {
  if (readTestAccountToken() || readDevBypassToken()) return 'dev-bypass';
  if (!(await isSupported())) return 'unavailable';
  if (Platform.OS === 'ios') return 'app-attest';
  if (Platform.OS === 'android') {
    return readAndroidHardwareId() ? 'play-integrity' : 'play-integrity-uuid';
  }
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

type AttestPlatform = 'ios' | 'android' | 'dev';

/**
 * Where a flow's LAST post goes. Sign-in posts to the platform's own route;
 * the move to phone sign-in posts the very same fields (fresh nonce plus
 * attestation) to `/device/convert`, signed in, with the platform named in the
 * body. `onPost` fires when the attestation is done and the post is about to
 * leave, which is where the move's progress steps from "checking" to "linking".
 */
type FlowTarget = { kind: 'sign-in' } | { kind: 'convert'; bindOnly?: boolean; onPost?: () => void };

interface FlowResponse {
  path: string;
  data: unknown;
}

async function finalPost(
  target: FlowTarget,
  platform: AttestPlatform,
  body: Record<string, unknown>,
): Promise<FlowResponse> {
  if (target.kind === 'sign-in') {
    const path = `/device/sign-in/${platform}`;
    return { path, data: await post(path, body) };
  }
  target.onPost?.();
  const convertBody = target.bindOnly ? { platform, bindOnly: true, ...body } : { platform, ...body };
  return { path: '/device/convert', data: await post('/device/convert', convertBody) };
}

/** Fields read off a sign-in response. Anything else is ignored, which is
 *  what keeps an older server that still returns `deviceRef` harmless. */
interface SessionResponseLike {
  user?: { id?: string };
  trialAvailable?: unknown;
  minted?: unknown;
}

interface ParsedSignIn {
  userId: string;
  trialAvailable: boolean | null;
  /** True only when this call CREATED the user (server commit b13da0d);
   *  false on every resume, including the bind-race loser, and when the
   *  field is absent (older server). */
  minted: boolean;
}

/** Pull the user id out of a better-auth session response. */
function requireUserId(path: string, data: SessionResponseLike): string {
  const userId = data?.user?.id;
  if (!userId || typeof userId !== 'string') {
    throw new ServerRejection(path, undefined, 'MALFORMED_SESSION_RESPONSE');
  }
  return userId;
}

/** Parse the sign-in response, tolerating servers that omit the optional
 *  fields. */
function parseSignIn(path: string, data: SessionResponseLike): ParsedSignIn {
  return {
    userId: requireUserId(path, data),
    trialAvailable: typeof data?.trialAvailable === 'boolean' ? data.trialAvailable : null,
    minted: data?.minted === true,
  };
}

/** ANDROID_ID — the Android deviceId (survives reinstall, resets on factory
 *  reset; the server keeps only a keyed hash of it). Null on failure or an
 *  empty value → stored-UUID fallback. */
function readAndroidHardwareId(): string | null {
  try {
    const id = Application.getAndroidId();
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

// ─── Hash and base64 helpers ─────────────────────────────────────────────────

function sha256Base64(input: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
}

/**
 * The value handed to Play Integrity as its nonce: the server nonce bound to
 * the deviceId this attempt sends, so a token cannot be replayed under a
 * different deviceId. Contract shared VERBATIM with the server:
 *   base64url_nopad(SHA-256(utf8(serverNonce + "|" + deviceId)))
 * Play Integrity requires a web-safe, no-wrap base64 nonce of 16 to 500
 * bytes; a SHA-256 is 32 bytes, 43 characters here, the same shape as the
 * server's own nonce. Test vector (asserted on both sides):
 *   serverNonce AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8, deviceId
 *   9774d56d682e549c -> 5E2pe4wGK3Y4kgsLKC7K_V4VgNADSzrL2Z2XA7p6iNY
 */
export async function bindIntegrityNonce(serverNonce: string, deviceId: string): Promise<string> {
  const standard = await sha256Base64(`${serverNonce}|${deviceId}`);
  return standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── Keychain-backed state ───────────────────────────────────────────────────

/** Distinguishes "no key stored" (null) from "keychain unreadable" (throws). */
function readStoredKeyId(): Promise<string | null> {
  return secureStore.getItemAsync(APP_ATTEST_KEY_ID_STORE_KEY);
}

async function clearStoredKeyId(): Promise<void> {
  for (const key of [APP_ATTEST_KEY_ID_STORE_KEY, APP_ATTEST_KEY_PROVEN_STORE_KEY]) {
    try {
      await secureStore.deleteItemAsync(key);
    } catch {
      // A failed delete only means the next attempt retries the same recovery.
    }
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

/** Fresh nonce → assertion over the nonce → the final POST. The nonce IS
 *  the client data (final S2 contract): the body carries it raw, and only the
 *  native call receives its hash. */
async function assertAndSignInIos(keyId: string, target: FlowTarget): Promise<FlowResponse> {
  const nonce = await fetchNonce('assert');
  const clientDataHash = await sha256Base64(nonce);
  const assertion = await generateAssertion(keyId, clientDataHash);
  const response = await finalPost(target, 'ios', { keyId, assertion, nonce });
  // The key has now completed a full assert round trip the server accepted:
  // PROVEN. Best-effort — an unproven marker only means one extra recovery is
  // armed.
  try {
    await secureStore.setItemAsync(APP_ATTEST_KEY_PROVEN_STORE_KEY, keyId);
  } catch {
    // Non-fatal.
  }
  return response;
}

async function signInIos(target: FlowTarget): Promise<FlowResponse> {
  const storedKeyId = await readStoredKeyId();
  if (!storedKeyId) {
    const keyId = await enrollIos();
    return assertAndSignInIos(keyId, target);
  }
  try {
    return await assertAndSignInIos(storedKeyId, target);
  } catch (error) {
    // Recovery 1: the stored key vanished (reinstall, device migration,
    // restore — App Attest keys survive none of them).
    // Recovery 2: a 400 assert rejection on a VIRGIN key — one that never
    // completed a sign-in. Seen in prod (MERA-APP team-id misconfig): the
    // enrollment went wrong server-side after the client had a key, so every
    // later assert 400s forever with no way out short of reinstall. A PROVEN
    // key's 400 stays a plain denial: it once worked, and re-enrolling would
    // destroy a good binding on a server verdict. An UNREADABLE proven marker
    // counts as proven — never sever on uncertainty.
    let recoverable = isInvalidKeyError(error);
    if (
      !recoverable &&
      error instanceof ServerRejection &&
      error.status === 400 &&
      error.code === 'DEVICE_ATTESTATION_FAILED'
    ) {
      let provenKeyId: string | null;
      try {
        provenKeyId = await secureStore.getItemAsync(APP_ATTEST_KEY_PROVEN_STORE_KEY);
      } catch {
        provenKeyId = storedKeyId;
      }
      recoverable = provenKeyId !== storedKeyId;
    }
    if (!recoverable) throw error;
    await clearStoredKeyId();
    const keyId = await enrollIos();
    return assertAndSignInIos(keyId, target);
  }
}

async function signInAndroid(target: FlowTarget): Promise<FlowResponse> {
  const nonce = await fetchNonce('integrity');
  // Resolved BEFORE the token request: it is an input to the bound nonce.
  // ANDROID_ID survives reinstall, which the stored UUID cannot; the fallback
  // keeps sign-in alive on the rare device where the read fails.
  const deviceId = readAndroidHardwareId() ?? (await readOrCreateDeviceId());
  const bound = await bindIntegrityNonce(nonce, deviceId);
  const integrityToken = await requestIntegrityToken(bound, readPlayIntegrityProject());
  // The body is unchanged: the RAW server nonce and the same deviceId.
  return finalPost(target, 'android', { integrityToken, nonce, deviceId });
}

/** Staging-only bypass: the route exists only where the server has
 *  DEVICE_ATTESTATION_DEV_BYPASS_TOKEN set (404 elsewhere). Keeps the stored
 *  UUID deviceId. */
async function signInDev(token: string, target: FlowTarget): Promise<FlowResponse> {
  const deviceId = await readOrCreateDeviceId();
  return finalPost(target, 'dev', { token, deviceId });
}

// ─── Test accounts (dev builds only) ─────────────────────────────────────────

/** POST to a test-account route. The path and the call sit INSIDE the
 *  `__DEV__` block so a release bundle carries neither. */
async function testAccountPost<T>(route: 'sign-in' | 'delete' | 'list', body: Record<string, unknown>): Promise<T> {
  if (__DEV__) {
    return post<T>(`/test-account/${route}`, body);
  }
  throw new Error('Test accounts exist only in dev builds');
}

/** The handle this device signs in to: the slot's, else a throwaway derived
 *  from the stored device UUID (stable per install). */
export async function currentTestAccountHandle(): Promise<string> {
  const stored = await secureStore.getItemAsync(TEST_ACCOUNT_HANDLE_STORE_KEY).catch(() => null);
  if (stored && TEST_ACCOUNT_HANDLE_PATTERN.test(stored)) return stored;
  const deviceId = await readOrCreateDeviceId();
  return `tmp-${deviceId.replace(/-/g, '').toLowerCase().slice(0, 12)}`;
}

/** Point this device at a handle (null: back to its throwaway). Throws on a
 *  handle the server would refuse, so nothing invalid is ever stored. */
export async function setTestAccountHandle(handle: string | null): Promise<void> {
  if (handle === null) {
    await secureStore.deleteItemAsync(TEST_ACCOUNT_HANDLE_STORE_KEY);
    return;
  }
  if (!TEST_ACCOUNT_HANDLE_PATTERN.test(handle)) throw new Error('Invalid test account handle');
  await secureStore.setItemAsync(TEST_ACCOUNT_HANDLE_STORE_KEY, handle);
}

async function signInTestAccount(token: string): Promise<FlowResponse> {
  const handle = await currentTestAccountHandle();
  return { path: 'test-account', data: await testAccountPost('sign-in', { token, handle }) };
}

/** Delete a test account now (a tombstone server side; the handle mints
 *  fresh next time). `not-found` covers a handle with no account, and also a
 *  wrong or disabled token, which the server answers with the same 404. */
export async function deleteTestAccount(handle: string): Promise<'deleted' | 'not-found' | 'failed'> {
  const token = readTestAccountToken();
  if (!token || !TEST_ACCOUNT_HANDLE_PATTERN.test(handle)) return 'failed';
  try {
    await testAccountPost('delete', { token, handle });
    return 'deleted';
  } catch (error) {
    if (error instanceof ServerRejection && error.status === 404) return 'not-found';
    logger.warn('[device-auth] test account delete failed', {
      ...(error instanceof ServerRejection ? { httpStatus: error.status, code: error.code } : {}),
    });
    return 'failed';
  }
}

export interface TestAccountSummary {
  handle: string;
  userId: string | null;
}

/** The test accounts the server holds, or null when the call failed. */
export async function listTestAccounts(): Promise<TestAccountSummary[] | null> {
  const token = readTestAccountToken();
  if (!token) return null;
  try {
    const data = await testAccountPost<{ accounts?: unknown }>('list', { token });
    if (!Array.isArray(data?.accounts)) return null;
    return data.accounts.flatMap((row: { handle?: unknown; userId?: unknown }) =>
      typeof row?.handle === 'string'
        ? [{ handle: row.handle, userId: typeof row.userId === 'string' ? row.userId : null }]
        : [],
    );
  } catch {
    return null;
  }
}

/** The flow this device runs, in the one decision order every reader shares:
 *  a test account (dev builds with its token, sign-in only: a test session is
 *  never moved or bound), the dev bypass (dev builds with the token), then
 *  native attestation. Null when the phone cannot attest at all. */
async function pickFlow(target: FlowTarget): Promise<(() => Promise<FlowResponse>) | null> {
  const testToken = target.kind === 'sign-in' ? readTestAccountToken() : '';
  if (testToken) return () => signInTestAccount(testToken);
  const token = readDevBypassToken();
  if (token) return () => signInDev(token, target);
  if (!(await isSupported())) return null;
  if (Platform.OS === 'ios') return () => signInIos(target);
  if (Platform.OS === 'android') return () => signInAndroid(target);
  return null;
}

/** 403 refusal of a STORED credential: the server no longer honors this
 *  device's binding (bound user missing, or the account was deleted). Distinct
 *  from a 400 (this attempt was rejected) and 503 (try later) — only the 403s
 *  sever. */
function isServerRefusal(error: unknown): boolean {
  return (
    error instanceof ServerRejection &&
    error.status === 403 &&
    (error.code === 'DEVICE_ATTESTATION_FAILED' || error.code === 'ACCOUNT_DELETED')
  );
}

// ─── Classification ──────────────────────────────────────────────────────────

function classifyFailure(error: unknown, what: 'sign-in' | 'convert' = 'sign-in'): DeviceSignInResult {
  const result = classify(error);
  // One structured console line per failed attempt (F4). Fields only — never
  // an error message and never a body, so no nonce or token can leak into it.
  const server = error instanceof ServerRejection ? error : undefined;
  const nativeCode = (error as { code?: unknown } | null)?.code;
  logger.warn(`[device-auth] ${what} failed`, {
    status: result.status,
    ...(result.status === 'failed' ? { reason: result.reason } : {}),
    ...(server
      ? { path: server.path, httpStatus: server.status, code: server.code }
      : typeof nativeCode === 'string'
        ? { code: nativeCode }
        : { errorName: error instanceof Error ? error.name : typeof error }),
  });
  return result;
}

function classify(error: unknown): DeviceSignInResult {
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
  // MERA-APP-6P: Play Integrity codes meaning this environment can
  // structurally never attest (no/old Play Store, non-GMS) — the same quiet
  // path as isSupported() === false: the phone isn't supported. Deliberately
  // BEFORE the capture below: an environment fact, not an
  // error; classifyFailure's single warn line is the only telemetry.
  // Transient integrity codes fall through and stay retryable.
  if (isIntegrityUnavailableError(error)) {
    return { status: 'unsupported' };
  }
  // Google's server or the device failed for now (-8/-12/-17/-100): retryable,
  // same as iOS's server-unavailable. A warning, so a sustained outage still
  // shows; the one 6P event was a Play pre-launch lab device.
  if (isIntegrityTransientError(error)) {
    logger.captureException(error, {
      level: 'warning',
      fingerprint: ['play-integrity-transient'],
      tags: { service: 'device-auth' },
    });
    return { status: 'failed', reason: 'attestation-unavailable' };
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
const TRANSIENT_INTEGRITY_RETRY_MS = 1500;

export async function signInWithDevice(): Promise<DeviceSignInResult> {
  try {
    const flow = await pickFlow({ kind: 'sign-in' });
    if (!flow) return { status: 'unsupported' };
    const runFlow = async (): Promise<ParsedSignIn> => {
      const { path, data } = await flow();
      return parseSignIn(path, data as SessionResponseLike);
    };

    // Snapshot BEFORE the attempt. Best-effort reads: this drives the
    // refusal-recovery gate, not the strict
    // keychain rule (signInIos keeps its own strict read).
    // An Android device on ANDROID_ID stores nothing here, so it never
    // retries: its record key is derived from ANDROID_ID, which severing
    // cannot change, so a retry could only earn the same 403.
    const [storedKey, storedDeviceId] = await Promise.all([
      secureStore.getItemAsync(APP_ATTEST_KEY_ID_STORE_KEY).catch(() => null),
      secureStore.getItemAsync(DEVICE_ID_STORE_KEY).catch(() => null),
    ]);
    // A test account has no binding to recover: a refusal there (a wrong
    // token's 404 included) must never sever this device's credentials.
    const testFlow = hasTestAccountToken();
    const hadStoredCredentials = !testFlow && Boolean(storedKey || storedDeviceId);

    let parsed: ParsedSignIn;
    try {
      parsed = await runFlow();
    } catch (error) {
      // MERA-APP-8F: Google's side failed for now. One retry a moment later,
      // with a fresh nonce, usually passes; a second failure is classified.
      if (isIntegrityTransientError(error)) {
        logger.warn('[device-auth] transient Play Integrity error; retrying once');
        await new Promise((resolve) => setTimeout(resolve, TRANSIENT_INTEGRITY_RETRY_MS));
        parsed = await runFlow();
      } else {
        // REFUSAL RECOVERY (S10): a stored credential the server refuses with a
        // 403 is dead (bound user gone, account deleted, or a key the server no
        // longer has a record for, which is what an account deletion leaves) —
        // sever everything and re-enroll fresh, ONCE. Mirrors the ERR_ATTEST_INVALID_KEY shape.
        // 400/503/network never clear credentials, and a fresh install has
        // nothing to recover.
        if (!hadStoredCredentials || !isServerRefusal(error)) throw error;
        logger.warn('[device-auth] stored credential refused; severing and re-enrolling once', {
          code: (error as ServerRejection).code,
        });
        await clearDeviceAuthCredentials();
        parsed = await runFlow();
      }
    }

    // Best-effort session-atom refresh. The recorder is what routing trusts.
    void authClient.getSession().catch(() => {});

    // A brand-new account takes any plan the store account holds (owner: at
    // mint and after a move only, never on resume). It runs once RevenueCat
    // is identified as this account. Lazy: revenuecat is not needed here.
    // A test account never takes the store plan.
    if (parsed.minted && !testFlow) {
      (require('@/lib/revenuecat') as typeof import('@/lib/revenuecat')).requestStorePurchasesSync(parsed.userId);
    }

    return {
      status: 'success',
      userId: parsed.userId,
      trialAvailable: parsed.trialAvailable,
      minted: parsed.minted,
    };
  } catch (error) {
    return classifyFailure(error);
  }
}

// ─── Move to phone sign-in ───────────────────────────────────────────────────

export type DeviceConvertStep = 'checking' | 'linking';

const CONVERT_OK = ['converted', 'already-converted', 'bound', 'already-bound'] as const;
type ConvertOk = (typeof CONVERT_OK)[number];

export type DeviceConvertResult =
  /** The move: the account is now bound to this phone and its email is gone
   *  server side (`already-converted`: done before, on this or another phone;
   *  treated the same). The silent bind (`bindOnly`): this phone is bound to
   *  the account and the email is left alone. */
  | { status: ConvertOk; supportId: string | null }
  | { status: 'unsupported' }
  /** Nothing changed. `step` is where it stopped: the phone check (nonce or
   *  attestation) or the convert call itself. */
  | { status: 'failed'; reason: DeviceSignInFailureReason; step: DeviceConvertStep };

function parseConvert(data: unknown): Extract<DeviceConvertResult, { status: ConvertOk }> {
  const body = data as { status?: unknown; supportId?: unknown } | null;
  const status = CONVERT_OK.find((s) => s === body?.status);
  if (!status) throw new ServerRejection('/device/convert', undefined, 'MALFORMED_CONVERT_RESPONSE');
  return { status, supportId: typeof body?.supportId === 'string' ? body.supportId : null };
}

/**
 * Move the SIGNED-IN account to this phone: the same nonce and attestation as
 * a sign-in, posted to `/device/convert`. With `bindOnly` (the silent launch
 * bind) the server only binds this phone and keeps the email. The server binds this phone to the
 * account (rebinding a phone that belonged to another account, by owner
 * decision), deletes the email and re-sets the session cookie for the same
 * user, so nothing local is wiped. Never throws.
 *
 * No S10 refusal recovery here: a convert never severs a stored credential.
 * The iOS key-local recoveries (invalid key, virgin key) still apply, since
 * they only concern this phone's own key.
 */
export async function convertWithDevice(
  onStep?: (step: DeviceConvertStep) => void,
  { bindOnly = false }: { bindOnly?: boolean } = {},
): Promise<DeviceConvertResult> {
  let step: DeviceConvertStep = 'checking';
  onStep?.(step);
  try {
    const flow = await pickFlow({
      kind: 'convert',
      bindOnly,
      onPost: () => {
        step = 'linking';
        onStep?.(step);
      },
    });
    if (!flow) return { status: 'unsupported' };
    return parseConvert((await flow()).data);
  } catch (error) {
    // 404: a server without the route yet (deploys land server first, same
    // day). 401: the session died ("no valid session"). Both temporary,
    // retried next launch, and not worth a Sentry event.
    if (error instanceof ServerRejection && (error.status === 404 || error.status === 401)) {
      logger.warn('[device-auth] convert not possible now', { path: error.path, httpStatus: error.status });
      return { status: 'failed', reason: 'attestation-unavailable', step };
    }
    const result = classifyFailure(error, 'convert');
    if (result.status === 'unsupported') return result;
    if (result.status === 'failed') return { status: 'failed', reason: result.reason, step };
    return { status: 'failed', reason: 'unknown', step };
  }
}
