// Google Drive, via the app-data folder.
//
// **`isCloudAvailable()` is useless here and must not be used.** The library
// documents it as "always returns true for Google Drive" — it answers a
// CloudKit question. Real availability for Drive is a different question
// entirely: do we hold a valid OAuth access token with the `drive.appdata`
// scope? So `isAvailable()` asks Google, not CloudStorage, and installs the
// token it gets back. This is the one place where copying the iCloud adapter's
// shape would produce a provider that reports itself ready and then fails every
// call.
//
// The token is short-lived, so it is refreshed before every operation rather
// than once at configure time. `signInSilently()` is what makes that free after
// the first interactive sign-in — the same lesson the Intercom JWT taught:
// mint-at-login passes testing and dies mid-session.
//
// `drive.appdata` grants access ONLY to a hidden per-app folder. It cannot read
// the user's own Drive files, which is why it is the scope to ask for: anything
// broader would be a permission the app has no use for and a verification
// requirement it does not need.

import { CloudStorage, CloudStorageProvider } from 'react-native-cloud-storage';

import { GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID } from '@/lib/config/endpoints';

import type { BackupProvider } from '../types';
import {
  BACKUP_SCOPE,
  BackupProviderError,
  downloadTo,
  listWithPrefix,
  removeRemote,
  uploadTo,
} from './shared';

export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

let instance: CloudStorage | null = null;
let configured = false;

function storage(): CloudStorage {
  instance ??= new CloudStorage(CloudStorageProvider.GoogleDrive, { scope: BACKUP_SCOPE });
  return instance;
}

/**
 * Bundle-time, synchronous, and the thing the UI gates on — never "did
 * `configure()` succeed". Gating a lazily-initialised SDK on its own init flag
 * deadlocks: the first read is false, the caller takes the fallback, and the
 * SDK is never initialised. Same trap `lib/intercom.ts` documents.
 */
export function isGoogleDriveConfigured(): boolean {
  return GOOGLE_WEB_CLIENT_ID !== '';
}

/**
 * Whether the google-signin NATIVE module is linked into this binary. Probed
 * via the non-enforcing TurboModuleRegistry lookup BEFORE any require of the
 * package: the package's module factory calls getEnforcing at import time, and
 * although every caller here already catches the resulting throw, Metro's
 * guarded require still REPORTS the factory error to LogBox in dev — so a
 * dev-client built without the module showed a scary "Uncaught Error" toast
 * the moment BackupSection probed availability (sim-caught, 2026-08-19). The
 * probe is cached: linkage cannot change within a process.
 */
let nativeLinked: boolean | null = null;
function googleSigninNativeLinked(): boolean {
  if (nativeLinked !== null) return nativeLinked;
  try {
    const { TurboModuleRegistry } =
      require('react-native') as typeof import('react-native');
    nativeLinked = TurboModuleRegistry.get('RNGoogleSignin') != null;
  } catch {
    nativeLinked = false;
  }
  return nativeLinked;
}

function ensureConfigured(): void {
  if (configured) return;
  const { GoogleSignin } = require('@react-native-google-signin/google-signin');
  GoogleSignin.configure({
    webClientId: GOOGLE_WEB_CLIENT_ID,
    // Absent on Android by design: that client is matched by package name plus
    // SHA-1 fingerprint and its id is never passed to the SDK.
    iosClientId: GOOGLE_IOS_CLIENT_ID || undefined,
    scopes: [DRIVE_APPDATA_SCOPE],
    offlineAccess: false,
  });
  configured = true;
}

/**
 * Fresh access token, or null when the user has not connected Drive.
 *
 * Silent only. An interactive sign-in belongs to a button press, never to a
 * background backup task — a scheduled backup that pops an account chooser is
 * a bug, not a prompt.
 */
async function currentAccessToken(): Promise<string | null> {
  if (!isGoogleDriveConfigured()) return null;
  if (!googleSigninNativeLinked()) return null;
  try {
    ensureConfigured();
    const { GoogleSignin } = require('@react-native-google-signin/google-signin');
    if (!GoogleSignin.hasPreviousSignIn()) return null;
    const silent = await GoogleSignin.signInSilently();
    if (silent?.type !== 'success') return null;
    const tokens = await GoogleSignin.getTokens();
    return tokens?.accessToken ?? null;
  } catch {
    return null;
  }
}

/** Installs a fresh token, or refuses with a reason the UI can render. */
async function withToken(): Promise<CloudStorage> {
  const accessToken = await currentAccessToken();
  if (!accessToken) {
    throw new BackupProviderError(
      'provider-unavailable',
      'Google Drive is not connected on this device',
    );
  }
  const s = storage();
  s.setProviderOptions({ scope: BACKUP_SCOPE, accessToken });
  return s;
}

export const googleDriveProvider: BackupProvider = {
  id: 'google-drive',

  async isAvailable(): Promise<boolean> {
    // Deliberately NOT CloudStorage.isCloudAvailable(), which is hardcoded true
    // for this provider. Holding a token IS the availability question.
    return (await currentAccessToken()) !== null;
  },

  async upload(localPath, remotePath) {
    return uploadTo(await withToken(), localPath, remotePath);
  },
  async download(remotePath, localPath) {
    return downloadTo(await withToken(), remotePath, localPath);
  },
  async list(prefix) {
    return listWithPrefix(await withToken(), prefix);
  },
  async remove(remotePath) {
    return removeRemote(await withToken(), remotePath);
  },
};

/**
 * Why an interactive connect did not finish.
 *
 * `cancelled` is separated from every failure on purpose. An earlier version
 * returned a bare `false` for both, and the symptom was exactly what you would
 * expect and nothing you could act on: the account chooser appeared, the user
 * signed in, and the screen did nothing. A configuration fault is not a
 * cancellation and must not be shown as one.
 */
export type DriveConnectResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'cancelled' }
  /** Android `DEVELOPER_ERROR` (status code 10). */
  | { readonly ok: false; readonly reason: 'misconfigured'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'play-services' }
  | { readonly ok: false; readonly reason: 'unknown'; readonly detail: string };

/** Android's `CommonStatusCodes.DEVELOPER_ERROR`, rejected as a string. */
const DEVELOPER_ERROR_CODE = '10';

/**
 * The interactive connect, for a button press only.
 *
 * **`DEVELOPER_ERROR` is the one worth naming.** Android rejects with status
 * code 10 when the OAuth client does not match the app — almost always because
 * the signing certificate's SHA-1 is not registered on the Android client in
 * the Google Cloud project. It is a build-configuration fault, so it reproduces
 * every single time and never for a reason the user can fix, which makes
 * swallowing it the worst possible handling: sign-in appears to succeed and the
 * app just sits there.
 */
export async function connectGoogleDrive(): Promise<DriveConnectResult> {
  if (!isGoogleDriveConfigured()) {
    return { ok: false, reason: 'misconfigured', detail: 'No Google client id in this build' };
  }
  if (!googleSigninNativeLinked()) {
    return { ok: false, reason: 'misconfigured', detail: 'Google Sign-In native module not in this build' };
  }
  ensureConfigured();
  const { GoogleSignin, statusCodes } = require('@react-native-google-signin/google-signin');
  try {
    // Play Services can be absent or outdated on Android; on iOS this resolves
    // immediately.
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const result = await GoogleSignin.signIn();
    if (result?.type === 'success') return { ok: true };
    return { ok: false, reason: 'cancelled' };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const detail = err instanceof Error ? err.message : String(err);
    if (code === statusCodes?.SIGN_IN_CANCELLED) return { ok: false, reason: 'cancelled' };
    if (code === statusCodes?.PLAY_SERVICES_NOT_AVAILABLE) {
      return { ok: false, reason: 'play-services' };
    }
    if (code === DEVELOPER_ERROR_CODE) return { ok: false, reason: 'misconfigured', detail };
    return { ok: false, reason: 'unknown', detail };
  }
}

/**
 * Disconnects Drive without touching the app's own session.
 *
 * A true no-op for the majority who never opted in: backup is opt-in, so most
 * logouts must not initialise a Google SDK at all. `hasPreviousSignIn()` is
 * synchronous and is the cheapest way to ask.
 */
export async function disconnectGoogleDrive(): Promise<void> {
  if (!isGoogleDriveConfigured()) return;
  if (!googleSigninNativeLinked()) return;
  try {
    ensureConfigured();
    const { GoogleSignin } = require('@react-native-google-signin/google-signin');
    if (!GoogleSignin.hasPreviousSignIn()) return;
    await GoogleSignin.signOut();
  } catch {
    // Already signed out, or the SDK is unavailable. Either way the outcome
    // the caller asked for is the one they get.
  }
}
