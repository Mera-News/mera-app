// JS surface of the local mera-device-attest Expo module.
//
// Resolution is lazy and guarded: in jest, Expo Go, or any build where the
// native module is absent, `isSupported()` resolves false and every other call
// rejects with ERR_ATTEST_UNSUPPORTED — the same shape a simulator produces —
// so callers have exactly one unsupported path to handle.
//
// All hashes are computed by the CALLER (expo-crypto): `attestKey` takes the
// base64 of SHA256(nonce), `generateAssertion` the base64 of
// SHA256(clientData). This module never hashes.

import { requireNativeModule } from 'expo-modules-core';

export type DeviceAttestErrorCode =
  | 'ERR_ATTEST_UNSUPPORTED'
  | 'ERR_ATTEST_INVALID_KEY'
  | 'ERR_ATTEST_INVALID_INPUT'
  | 'ERR_ATTEST_SERVER_UNAVAILABLE'
  | 'ERR_ATTEST_INTEGRITY_FAILED'
  | 'ERR_ATTEST_UNKNOWN';

interface NativeMeraDeviceAttest {
  isSupported(): Promise<boolean>;
  // iOS only
  generateKey?(): Promise<string>;
  attestKey?(keyId: string, challengeBase64: string): Promise<string>;
  generateAssertion?(keyId: string, clientDataHashBase64: string): Promise<string>;
  // Android only
  requestIntegrityToken?(nonce: string, cloudProjectNumber: string | null): Promise<string>;
}

let nativeModule: NativeMeraDeviceAttest | null | undefined;

function resolveNative(): NativeMeraDeviceAttest | null {
  if (nativeModule !== undefined) return nativeModule;
  try {
    nativeModule = requireNativeModule<NativeMeraDeviceAttest>('MeraDeviceAttest');
  } catch {
    nativeModule = null;
  }
  return nativeModule;
}

/** Typed error thrown by the JS layer when the native module is absent or a
 *  platform function does not exist on this OS. Native rejections carry their
 *  own `code` (Expo propagates the exception code onto the JS error). */
export class DeviceAttestUnsupportedError extends Error {
  code: DeviceAttestErrorCode = 'ERR_ATTEST_UNSUPPORTED';
  constructor() {
    super('Device attestation is not supported in this environment');
    this.name = 'DeviceAttestUnsupportedError';
  }
}

/** Read the `code` Expo attaches to native rejections, if any. */
export function deviceAttestErrorCode(error: unknown): DeviceAttestErrorCode | null {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string') return null;
  return code.startsWith('ERR_ATTEST_') ? (code as DeviceAttestErrorCode) : null;
}

export function isInvalidKeyError(error: unknown): boolean {
  return deviceAttestErrorCode(error) === 'ERR_ATTEST_INVALID_KEY';
}

/**
 * IntegrityErrorCode values meaning this ENVIRONMENT can structurally never
 * produce a verdict — non-GMS Androids, missing or ancient Play Store. At
 * best user-fixable (update the Play Store), never fixable by our retry loop,
 * so callers treat them exactly like `isSupported() === false`.
 *
 * Verified against the official IntegrityErrorCode reference:
 *  -1 API_NOT_AVAILABLE            -2 PLAY_STORE_NOT_FOUND
 *  -6 PLAY_SERVICES_NOT_FOUND      -9 CANNOT_BIND_TO_SERVICE
 * -14 PLAY_STORE_VERSION_OUTDATED -15 PLAY_SERVICES_VERSION_OUTDATED
 * Transient/misuse codes (-3 NETWORK_ERROR, -8 TOO_MANY_REQUESTS,
 * -12 GOOGLE_SERVER_UNAVAILABLE, -17 CLIENT_TRANSIENT_ERROR, -100
 * INTERNAL_ERROR, nonce/config misuse) keep the retryable failure path.
 */
const PERMANENT_INTEGRITY_ERROR_CODES = new Set([-1, -2, -6, -9, -14, -15]);

/** True when a Play Integrity rejection means "this device can never attest".
 *  JS-side classification on purpose (OTA-deliverable for runtime 1.3.0):
 *  play-core embeds the IntegrityErrorCode as the first negative integer in
 *  the exception message ("Integrity API error (-1): ..."), which the Kotlin
 *  module passes through in its rejection message. */
export function isIntegrityUnavailableError(error: unknown): boolean {
  if (deviceAttestErrorCode(error) !== 'ERR_ATTEST_INTEGRITY_FAILED') return false;
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = message.match(/-\d+/);
  return match !== null && PERMANENT_INTEGRITY_ERROR_CODES.has(Number(match[0]));
}

/** False on simulators/emulators, in jest, in Expo Go, and on unsupported
 *  hardware. Never rejects. */
export async function isSupported(): Promise<boolean> {
  const native = resolveNative();
  if (!native) return false;
  try {
    return await native.isSupported();
  } catch {
    return false;
  }
}

/** iOS: create a new App Attest key. Resolves the keyId. */
export async function generateKey(): Promise<string> {
  const native = resolveNative();
  if (!native?.generateKey) throw new DeviceAttestUnsupportedError();
  return native.generateKey();
}

/** iOS: attest a freshly generated key. `challengeBase64` = base64(SHA256(nonce)).
 *  Resolves the base64 attestation object. */
export async function attestKey(keyId: string, challengeBase64: string): Promise<string> {
  const native = resolveNative();
  if (!native?.attestKey) throw new DeviceAttestUnsupportedError();
  return native.attestKey(keyId, challengeBase64);
}

/** iOS: sign a client-data hash with an attested key.
 *  `clientDataHashBase64` = base64(SHA256(clientData JSON)). Resolves the
 *  base64 assertion. Rejects ERR_ATTEST_INVALID_KEY when the key is gone
 *  (reinstall/restore) — clear the stored keyId and re-enroll. */
export async function generateAssertion(
  keyId: string,
  clientDataHashBase64: string,
): Promise<string> {
  const native = resolveNative();
  if (!native?.generateAssertion) throw new DeviceAttestUnsupportedError();
  return native.generateAssertion(keyId, clientDataHashBase64);
}

/** Android: request a Play Integrity classic token bound to `nonce`. */
export async function requestIntegrityToken(
  nonce: string,
  cloudProjectNumber: string | null,
): Promise<string> {
  const native = resolveNative();
  if (!native?.requestIntegrityToken) throw new DeviceAttestUnsupportedError();
  return native.requestIntegrityToken(nonce, cloudProjectNumber);
}

/** Test seam: force re-resolution of the native module. */
export function __resetDeviceAttestForTests(): void {
  nativeModule = undefined;
}
