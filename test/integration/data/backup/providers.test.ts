// The two provider adapters and the helpers they share, over the cloud-storage fake (a remote that
// keeps bytes) and the google-signin edge mock. Specifically the four things that fail SILENTLY on a
// device and nowhere else:
//   1. `uploadFile` takes (remote, local); the port takes (local, remote). A swap uploads nothing.
//   2. `downloadFile` is overloaded; the 2-argument form only triggers an iCloud sync and copies nothing.
//   3. `isCloudAvailable()` is hardcoded true for Drive, so trusting it reports ready and fails every call.
//   4. Drive holds a Google account NATIVELY, so a logout that does not disconnect it hands the next
//      person someone else's Drive.
//
// Replaces lib/backup/__tests__/providers.test.ts (all 27 `it`). Not carried over: none dropped.
// The legacy suite mocked `config/endpoints` and wholesale `react-native`; the integration env has
// neither GOOGLE_*_CLIENT_ID (so Drive is unconfigured by default, which is itself tested) nor a
// linked RNGoogleSignin TurboModule. A configured, linked Drive is therefore built per test by loading
// google-drive.ts in an isolated registry with the env var set and `TurboModuleRegistry.get` answering
// for the native module (the file's `nativeLinked` / `configured` / `instance` state cannot be reset).
// Harness gap, for a ruling: the integration setup could carry both client ids and the module probe.
import { Platform, TurboModuleRegistry } from 'react-native';
import {
  CloudStorage,
  CloudStorageError,
  CloudStorageErrorCode,
  CloudStorageProvider,
  CloudStorageScope,
} from 'react-native-cloud-storage';
import { GoogleSignin } from '@react-native-google-signin/google-signin';

import { icloudProvider, isICloudSupported } from '@/lib/backup/providers/icloud';
import {
  BACKUP_SCOPE,
  BackupProviderError,
  REMOTE_DIRECTORY,
  downloadTo,
  ensureRemoteDirectory,
  listWithPrefix,
  removeRemote,
  toRefusal,
  uploadTo,
} from '@/lib/backup/providers/shared';

jest.mock('react-native-cloud-storage', () => require('./fakes').cloudStorageModule);

import { callsTo, putRemote, remoteBytes, remoteNames, resetFakes, shared } from './fakes';

const gsi = GoogleSignin as unknown as Record<string, jest.Mock>;

let registrySpy: jest.SpyInstance;

beforeEach(() => {
  resetFakes();
  gsi.hasPlayServices.mockImplementation(async () => true);
  gsi.hasPreviousSignIn.mockImplementation(() => true);
  gsi.signIn.mockImplementation(async () => ({ type: 'success' }));
  gsi.signInSilently.mockImplementation(async () => ({ type: 'success' }));
  gsi.signOut.mockImplementation(async () => undefined);
  gsi.getTokens.mockImplementation(async () => ({ accessToken: 'ya29.fresh' }));
  registrySpy = jest.spyOn(TurboModuleRegistry, 'get').mockImplementation((() => null) as never);
});

afterEach(() => {
  registrySpy.mockRestore();
});

// the package types its error with a (code, message) constructor; the fake takes the code alone
const cloudError = (code: string) => new (CloudStorageError as unknown as new (code: string) => Error)(code);
const put = (path: string, text: string) => shared.disk.set(path, new TextEncoder().encode(text));
const text = (bytes?: Uint8Array) => (bytes ? new TextDecoder().decode(bytes) : undefined);

function setPlatform(os: 'ios' | 'android'): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}
afterEach(() => setPlatform('ios'));

describe('the CloudStorage argument traps', () => {
  it('uploads REMOTE-first, because the library inverts the port order: the bytes arrive at the remote path', async () => {
    put('/local/blob.bin', 'ciphertext');
    await icloudProvider.upload('/local/blob.bin', `${REMOTE_DIRECTORY}/b1.bin`);

    const [call] = callsTo('uploadFile');
    expect(call.args[0]).toBe(`${REMOTE_DIRECTORY}/b1.bin`);
    expect(call.args[1]).toBe('/local/blob.bin');
    expect(call.args[2]).toEqual({ mimeType: 'application/octet-stream' });
    // a swapped call would have found no local file and thrown
    expect(text(remoteBytes(`${REMOTE_DIRECTORY}/b1.bin`))).toBe('ciphertext');
  });

  it('downloads with THREE arguments, so the copying overload is the one that matches', async () => {
    // Two arguments is `downloadFile(path, scope?)`: it only triggers an iCloud sync, copies
    // nothing and resolves happily, so the symptom is an empty local file rather than an error.
    putRemote(`${REMOTE_DIRECTORY}/b1.bin`, new TextEncoder().encode('ciphertext'));
    await icloudProvider.download(`${REMOTE_DIRECTORY}/b1.bin`, '/local/blob.bin');

    const [call] = callsTo('downloadFile');
    expect(call.args).toHaveLength(3);
    expect(call.args[1]).toBe('/local/blob.bin');
    expect(call.args[2]).toBe('app_data');
    expect(text(shared.disk.get('/local/blob.bin'))).toBe('ciphertext');
  });

  it('never reaches for the string-only readFile/writeFile', async () => {
    put('/local/blob.bin', 'x');
    await icloudProvider.upload('/local/blob.bin', `${REMOTE_DIRECTORY}/b1.bin`);
    await icloudProvider.download(`${REMOTE_DIRECTORY}/b1.bin`, '/local/copy.bin');
    await icloudProvider.list('mera');
    await icloudProvider.remove(`${REMOTE_DIRECTORY}/b1.bin`);
    // A 25 MB blob through either would be base64'd into JS memory whole. The fake has neither
    // method, so a call would have thrown; this pins the set of methods used.
    expect(new Set(shared.calls.map((c) => c.name))).toEqual(
      new Set(['exists', 'mkdir', 'uploadFile', 'downloadFile', 'readdir', 'unlink']),
    );
  });

  it('scopes every operation to app-data, not the user-visible Documents', async () => {
    put('/local/blob.bin', 'x');
    await icloudProvider.upload('/local/blob.bin', `${REMOTE_DIRECTORY}/b1.bin`);
    await icloudProvider.download(`${REMOTE_DIRECTORY}/b1.bin`, '/local/copy.bin');
    await icloudProvider.list('mera');
    await icloudProvider.remove(`${REMOTE_DIRECTORY}/b1.bin`);
    expect(BACKUP_SCOPE).toBe(CloudStorageScope.AppData);
    for (const call of shared.calls) expect(call.args).toContain('app_data');
  });
});

describe('iCloud availability is a runtime question', () => {
  it('is unsupported, and false without asking CloudKit, off iOS', async () => {
    setPlatform('android');
    expect(isICloudSupported()).toBe(false);
    expect(await icloudProvider.isAvailable()).toBe(false);
    expect(callsTo('isCloudAvailable')).toHaveLength(0);
  });

  it('asks CloudKit on iOS rather than inferring from the platform', async () => {
    expect(isICloudSupported()).toBe(true);
    expect(await icloudProvider.isAvailable()).toBe(true);
    // an iPhone with iCloud switched off is still an iPhone
    shared.icloudAvailable = false;
    expect(await icloudProvider.isAvailable()).toBe(false);
    expect(callsTo('isCloudAvailable')).toHaveLength(2);
  });

  it('reports unavailable rather than throwing at a settings screen', async () => {
    shared.failOn = { method: 'isCloudAvailable', code: 'ERR_UNKNOWN' };
    expect(await icloudProvider.isAvailable()).toBe(false);
  });
});

describe('failure mapping', () => {
  it('reports a missing file as not-found', async () => {
    await expect(icloudProvider.download(`${REMOTE_DIRECTORY}/gone.bin`, '/local/x.bin')).rejects.toMatchObject({
      name: 'BackupProviderError',
      reason: 'not-found',
    });
  });

  it('reports everything else as provider-unavailable, never as a missing backup', async () => {
    // Quota, an expired token and a dead network are one situation from the user's side: try again
    // later. Calling any of them not-found would tell them their backup is gone.
    put('/local/a.bin', 'x');
    shared.failOn = { method: 'uploadFile', code: 'ERR_WRITE_ERROR' };
    await expect(icloudProvider.upload('/local/a.bin', `${REMOTE_DIRECTORY}/a.bin`)).rejects.toMatchObject({
      reason: 'provider-unavailable',
    });
  });

  it('treats an absent backup directory as no backups, not as an error', async () => {
    expect(await icloudProvider.list('mera-backup')).toEqual([]);
    // and the same when the directory vanishes between the exists check and the read
    putRemote(`${REMOTE_DIRECTORY}/mera-backup-1.bin`, new Uint8Array(1));
    shared.failOn = { method: 'readdir', code: CloudStorageErrorCode.DIRECTORY_NOT_FOUND };
    expect(await icloudProvider.list('mera-backup')).toEqual([]);
  });

  it('reports a failed listing as provider-unavailable', async () => {
    shared.failOn = { method: 'exists', code: 'ERR_OFFLINE' };
    await expect(icloudProvider.list('mera-backup')).rejects.toMatchObject({ reason: 'provider-unavailable' });
  });

  it('treats deleting an already-gone file as success', async () => {
    await expect(icloudProvider.remove(`${REMOTE_DIRECTORY}/gone.bin`)).resolves.toBeUndefined();
    expect(callsTo('unlink')).toHaveLength(1);
  });

  it('reports a failed delete as provider-unavailable', async () => {
    shared.failOn = { method: 'unlink', code: 'ERR_OFFLINE' };
    await expect(icloudProvider.remove(`${REMOTE_DIRECTORY}/a.bin`)).rejects.toMatchObject({
      reason: 'provider-unavailable',
    });
  });

  it('does not re-create a directory that is already there', async () => {
    putRemote(`${REMOTE_DIRECTORY}/other.bin`, new Uint8Array(1));
    put('/local/a.bin', 'x');
    await icloudProvider.upload('/local/a.bin', `${REMOTE_DIRECTORY}/a.bin`);
    expect(callsTo('mkdir')).toHaveLength(0);
  });

  it('creates the directory on the first upload', async () => {
    put('/local/a.bin', 'x');
    await icloudProvider.upload('/local/a.bin', `${REMOTE_DIRECTORY}/a.bin`);
    expect(callsTo('mkdir')).toHaveLength(1);
    expect(remoteNames()).toEqual([`${REMOTE_DIRECTORY}/a.bin`]);
  });
});

describe('listing', () => {
  it('filters by prefix and returns full remote paths, sorted', async () => {
    for (const name of ['mera-backup-2.bin', 'mera-backup-1.bin', 'something-else.txt']) {
      putRemote(`${REMOTE_DIRECTORY}/${name}`, new Uint8Array(1));
    }
    expect(await icloudProvider.list('mera-backup')).toEqual([
      `${REMOTE_DIRECTORY}/mera-backup-1.bin`,
      `${REMOTE_DIRECTORY}/mera-backup-2.bin`,
    ]);
  });
});

describe('the shared helpers', () => {
  const storage = () => new CloudStorage(CloudStorageProvider.ICloud, { scope: BACKUP_SCOPE } as never);

  it('toRefusal: a missing file or directory is not-found, anything else provider-unavailable, cause kept', () => {
    expect(toRefusal(cloudError(CloudStorageErrorCode.FILE_NOT_FOUND), 'x').reason).toBe('not-found');
    expect(toRefusal(cloudError(CloudStorageErrorCode.DIRECTORY_NOT_FOUND), 'x').reason).toBe('not-found');

    const plain = new Error('socket hang up');
    const refusal = toRefusal(plain, 'Upload failed');
    expect(refusal).toBeInstanceOf(BackupProviderError);
    expect(refusal.reason).toBe('provider-unavailable');
    expect(refusal.message).toContain('Upload failed');
    expect(refusal.cause).toBe(plain);
    expect(toRefusal(cloudError('ERR_QUOTA'), 'x').reason).toBe('provider-unavailable');
  });

  it('ensureRemoteDirectory: creates once, tolerates a racing creator, refuses any other failure', async () => {
    await ensureRemoteDirectory(storage());
    await ensureRemoteDirectory(storage());
    expect(callsTo('mkdir')).toHaveLength(1);

    resetFakes();
    shared.failOn = { method: 'mkdir', code: CloudStorageErrorCode.FILE_ALREADY_EXISTS };
    await expect(ensureRemoteDirectory(storage())).resolves.toBeUndefined();

    shared.failOn = { method: 'mkdir', code: 'ERR_QUOTA' };
    await expect(ensureRemoteDirectory(storage())).rejects.toMatchObject({ reason: 'provider-unavailable' });
  });

  it('uploadTo / downloadTo / listWithPrefix / removeRemote round-trip a file through the remote', async () => {
    put('/local/a.bin', 'payload');
    await uploadTo(storage(), '/local/a.bin', `${REMOTE_DIRECTORY}/mera-backup-a.bin`);
    expect(await listWithPrefix(storage(), 'mera-backup-')).toEqual([`${REMOTE_DIRECTORY}/mera-backup-a.bin`]);

    await downloadTo(storage(), `${REMOTE_DIRECTORY}/mera-backup-a.bin`, '/local/copy.bin');
    expect(text(shared.disk.get('/local/copy.bin'))).toBe('payload');

    await removeRemote(storage(), `${REMOTE_DIRECTORY}/mera-backup-a.bin`);
    expect(await listWithPrefix(storage(), 'mera-backup-')).toEqual([]);
  });

  it('uploadTo refuses before uploading when the directory cannot be created', async () => {
    put('/local/a.bin', 'x');
    shared.failOn = { method: 'mkdir', code: 'ERR_QUOTA' };
    await expect(uploadTo(storage(), '/local/a.bin', `${REMOTE_DIRECTORY}/a.bin`)).rejects.toMatchObject({
      reason: 'provider-unavailable',
    });
    expect(callsTo('uploadFile')).toHaveLength(0);
  });
});

// ---- Google Drive ---------------------------------------------------------

type DriveModule = typeof import('@/lib/backup/providers/google-drive');

/** A fresh google-drive.ts with its client ids from the env, so its module state starts clean. */
function loadDrive(options: { webClientId?: string; iosClientId?: string; linked?: boolean } = {}): DriveModule {
  const { webClientId = 'web-client-id', iosClientId = 'ios-client-id', linked = true } = options;
  const env = { web: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID, ios: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID };
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = webClientId;
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = iosClientId;
  registrySpy.mockImplementation((name: string) =>
    linked && name === 'RNGoogleSignin' ? {} : null,
  );
  let drive!: DriveModule;
  try {
    jest.isolateModules(() => {
      drive = require('@/lib/backup/providers/google-drive');
    });
  } finally {
    if (env.web === undefined) delete process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
    else process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = env.web;
    if (env.ios === undefined) delete process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
    else process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = env.ios;
  }
  return drive;
}

const REMOTE = `${REMOTE_DIRECTORY}/mera-backup-a.bin`;

describe('Drive is unusable until the build carries a client id and the native module', () => {
  it('is unconfigured in the integration env, which carries no Google client id', () => {
    jest.isolateModules(() => {
      const drive = require('@/lib/backup/providers/google-drive') as DriveModule;
      expect(drive.isGoogleDriveConfigured()).toBe(false);
    });
  });

  it('is configured once a web client id is present', () => {
    expect(loadDrive().isGoogleDriveConfigured()).toBe(true);
  });

  it('unconfigured: unavailable, refuses, touches no Google SDK, and connect says why', async () => {
    const drive = loadDrive({ webClientId: '' });
    expect(drive.isGoogleDriveConfigured()).toBe(false);
    expect(await drive.googleDriveProvider.isAvailable()).toBe(false);
    await expect(drive.googleDriveProvider.upload('/local/a.bin', REMOTE)).rejects.toMatchObject({
      reason: 'provider-unavailable',
    });
    expect(await drive.connectGoogleDrive()).toEqual({
      ok: false,
      reason: 'misconfigured',
      detail: 'No Google client id in this build',
    });
    await drive.disconnectGoogleDrive();
    expect(gsi.configure).not.toHaveBeenCalled();
    expect(gsi.signOut).not.toHaveBeenCalled();
  });

  it('native module not linked: unavailable without configuring the SDK, and connect says why', async () => {
    const drive = loadDrive({ linked: false });
    expect(await drive.googleDriveProvider.isAvailable()).toBe(false);
    expect(await drive.connectGoogleDrive()).toMatchObject({ ok: false, reason: 'misconfigured' });
    await drive.disconnectGoogleDrive();
    expect(gsi.configure).not.toHaveBeenCalled();
    expect(gsi.signIn).not.toHaveBeenCalled();
    expect(gsi.signOut).not.toHaveBeenCalled();
  });
});

describe('Drive availability is a TOKEN question, not a CloudKit one', () => {
  it('never calls isCloudAvailable, which is hardcoded true for this provider', async () => {
    await loadDrive().googleDriveProvider.isAvailable();
    expect(callsTo('isCloudAvailable')).toHaveLength(0);
  });

  it('is available when a silent sign-in yields an access token', async () => {
    expect(await loadDrive().googleDriveProvider.isAvailable()).toBe(true);
  });

  it('is unavailable when nobody has ever connected Drive, without popping an account chooser', async () => {
    gsi.hasPreviousSignIn.mockImplementation(() => false);
    expect(await loadDrive().googleDriveProvider.isAvailable()).toBe(false);
    expect(gsi.signIn).not.toHaveBeenCalled();
    expect(gsi.signInSilently).not.toHaveBeenCalled();
  });

  it('is unavailable when the saved credential no longer resolves', async () => {
    gsi.signInSilently.mockImplementation(async () => ({ type: 'noSavedCredentialFound' }));
    expect(await loadDrive().googleDriveProvider.isAvailable()).toBe(false);
  });

  it('is unavailable when the SDK throws, rather than throwing at a settings screen', async () => {
    gsi.signInSilently.mockImplementation(async () => {
      throw new Error('network');
    });
    expect(await loadDrive().googleDriveProvider.isAvailable()).toBe(false);
  });

  it('installs a FRESH token before every operation, not once at configure', async () => {
    // The token is short-lived. Minting it at connect time passes testing and dies mid-session.
    const drive = loadDrive();
    put('/local/a.bin', 'a');
    put('/local/b.bin', 'b');
    gsi.getTokens.mockImplementationOnce(async () => ({ accessToken: 'token-1' }));
    await drive.googleDriveProvider.upload('/local/a.bin', `${REMOTE_DIRECTORY}/a.bin`);
    gsi.getTokens.mockImplementationOnce(async () => ({ accessToken: 'token-2' }));
    await drive.googleDriveProvider.upload('/local/b.bin', `${REMOTE_DIRECTORY}/b.bin`);

    expect(callsTo('uploadFile').map((c) => c.accessToken)).toEqual(['token-1', 'token-2']);
    expect(remoteNames('googledrive')).toEqual([`${REMOTE_DIRECTORY}/a.bin`, `${REMOTE_DIRECTORY}/b.bin`]);
  });

  it('carries the token on download, list and remove too', async () => {
    const drive = loadDrive();
    putRemote(`${REMOTE_DIRECTORY}/mera-backup-a.bin`, new TextEncoder().encode('payload'), 'googledrive');
    gsi.getTokens.mockImplementation(async () => ({ accessToken: 'tok' }));

    expect(await drive.googleDriveProvider.list('mera-backup')).toEqual([`${REMOTE_DIRECTORY}/mera-backup-a.bin`]);
    await drive.googleDriveProvider.download(`${REMOTE_DIRECTORY}/mera-backup-a.bin`, '/local/c.bin');
    expect(text(shared.disk.get('/local/c.bin'))).toBe('payload');
    await drive.googleDriveProvider.remove(`${REMOTE_DIRECTORY}/mera-backup-a.bin`);

    expect(remoteNames('googledrive')).toEqual([]);
    for (const call of shared.calls.filter((c) => c.name !== 'setProviderOptions')) expect(call.accessToken).toBe('tok');
  });

  it('refuses with provider-unavailable rather than uploading tokenless', async () => {
    gsi.hasPreviousSignIn.mockImplementation(() => false);
    put('/local/a.bin', 'a');
    await expect(loadDrive().googleDriveProvider.upload('/local/a.bin', REMOTE)).rejects.toMatchObject({
      reason: 'provider-unavailable',
    });
    expect(callsTo('uploadFile')).toHaveLength(0);
  });

  it('asks only for drive.appdata, which cannot read the user\'s own Drive files', async () => {
    const drive = loadDrive();
    await drive.googleDriveProvider.isAvailable();
    await drive.googleDriveProvider.isAvailable();
    // configured once per process, however many operations follow
    expect(gsi.configure).toHaveBeenCalledTimes(1);
    expect(gsi.configure).toHaveBeenCalledWith({
      webClientId: 'web-client-id',
      iosClientId: 'ios-client-id',
      scopes: ['https://www.googleapis.com/auth/drive.appdata'],
      offlineAccess: false,
    });
    expect(drive.DRIVE_APPDATA_SCOPE).toBe('https://www.googleapis.com/auth/drive.appdata');
  });

  it('passes no android client id (matched by package plus SHA-1), and no ios id when the build has none', async () => {
    const drive = loadDrive({ iosClientId: '' });
    await drive.googleDriveProvider.isAvailable();
    const config = gsi.configure.mock.calls[0][0];
    expect(config).not.toHaveProperty('androidClientId');
    expect(config.webClientId).toBe('web-client-id');
    expect(config.iosClientId).toBeUndefined();
  });
});

describe('connecting is a button press, and each way it can end is told apart', () => {
  it('connects when the account chooser completes', async () => {
    const drive = loadDrive();
    expect(await drive.connectGoogleDrive()).toEqual({ ok: true });
    expect(gsi.hasPlayServices).toHaveBeenCalledWith({ showPlayServicesUpdateDialog: true });
  });

  it('reports a dismissed chooser as cancelled, by result and by status code', async () => {
    const drive = loadDrive();
    gsi.signIn.mockImplementationOnce(async () => ({ type: 'cancelled' }));
    expect(await drive.connectGoogleDrive()).toEqual({ ok: false, reason: 'cancelled' });

    gsi.signIn.mockImplementationOnce(async () => {
      throw Object.assign(new Error('user cancelled'), { code: 'SIGN_IN_CANCELLED' });
    });
    expect(await drive.connectGoogleDrive()).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('reports missing Play Services on its own', async () => {
    const drive = loadDrive();
    gsi.hasPlayServices.mockImplementationOnce(async () => {
      throw Object.assign(new Error('no play services'), { code: 'PLAY_SERVICES_NOT_AVAILABLE' });
    });
    expect(await drive.connectGoogleDrive()).toEqual({ ok: false, reason: 'play-services' });
  });

  it('does not mistake Android DEVELOPER_ERROR (code 10) for a cancellation', async () => {
    // A signing-certificate mismatch reproduces every time and no user action fixes it, so
    // swallowing it as "cancelled" makes sign-in look like it worked while nothing happens.
    const drive = loadDrive();
    gsi.signIn.mockImplementationOnce(async () => {
      throw Object.assign(new Error('DEVELOPER_ERROR'), { code: '10' });
    });
    expect(await drive.connectGoogleDrive()).toEqual({
      ok: false,
      reason: 'misconfigured',
      detail: 'DEVELOPER_ERROR',
    });
  });

  it('reports anything else as unknown, with its message', async () => {
    const drive = loadDrive();
    gsi.signIn.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    expect(await drive.connectGoogleDrive()).toEqual({ ok: false, reason: 'unknown', detail: 'boom' });
  });
});

describe('Drive holds a Google account natively, so logout must disconnect it', () => {
  it('is a true no-op for the majority who never opted in', async () => {
    // Backup is opt-in, so most logouts must not initialise a Google SDK at all, let alone call
    // signOut on an account that was never connected.
    gsi.hasPreviousSignIn.mockImplementation(() => false);
    await loadDrive().disconnectGoogleDrive();
    expect(gsi.signOut).not.toHaveBeenCalled();
  });

  it('signs the account out without revoking the grant', async () => {
    await loadDrive().disconnectGoogleDrive();
    expect(gsi.signOut).toHaveBeenCalledTimes(1);
    // revokeAccess would also drop the grant: a different and more destructive thing than
    // "this device stops using Drive"
    expect(gsi.revokeAccess).not.toHaveBeenCalled();
  });

  it('swallows a failing disconnect, because the local wipe awaits it', async () => {
    gsi.signOut.mockImplementationOnce(async () => {
      throw new Error('no network');
    });
    await expect(loadDrive().disconnectGoogleDrive()).resolves.toBeUndefined();
  });
});
