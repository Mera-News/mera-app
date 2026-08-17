// The two provider adapters, and specifically the four things that would fail
// SILENTLY on a device and nowhere else.
//
//   1. `uploadFile` takes (remote, local). The port takes (local, remote). A
//      swap uploads a path-shaped string as the file contents.
//   2. `downloadFile` is overloaded and the deprecated arity merely triggers an
//      iCloud sync — it copies nothing and resolves happily.
//   3. `isCloudAvailable()` is hardcoded true for Google Drive, so an adapter
//      that trusts it reports itself ready and then fails every call.
//   4. Drive holds a Google account NATIVELY, so a logout that does not
//      disconnect it hands the next user someone else's Drive.

const cloudCalls: { name: string; args: unknown[] }[] = [];

let mockExists = true;
let mockReaddir: string[] = [];
let mockThrowOn: { method: string; code: string } | null = null;

jest.mock('react-native-cloud-storage', () => {
  // Declared INSIDE the factory. babel-jest hoists jest.mock above the imports,
  // and shared.ts imports this module statically, so the factory runs before a
  // top-level `class` binding has left its temporal dead zone. The symptom is
  // not a clear ReferenceError either — CloudStorageError arrives undefined and
  // every `err instanceof CloudStorageError` throws "Right-hand side of
  // 'instanceof' is not an object" from inside the code under test.
  class MockCloudStorageError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }
  const record = (name: string) =>
    jest.fn(async (...args: unknown[]) => {
      cloudCalls.push({ name, args });
      if (mockThrowOn?.method === name) throw new MockCloudStorageError(mockThrowOn.code);
      if (name === 'exists') return mockExists;
      if (name === 'readdir') return mockReaddir;
      if (name === 'isCloudAvailable') return true;
      return undefined;
    });
  class CloudStorage {
    isCloudAvailable = record('isCloudAvailable');
    exists = record('exists');
    mkdir = record('mkdir');
    uploadFile = record('uploadFile');
    downloadFile = record('downloadFile');
    readdir = record('readdir');
    unlink = record('unlink');
    setProviderOptions = jest.fn((o: unknown) => {
      cloudCalls.push({ name: 'setProviderOptions', args: [o] });
    });
    subscribeToCloudAvailability = jest.fn((l: unknown) => {
      cloudCalls.push({ name: 'subscribe', args: [l] });
    });
    unsubscribeFromCloudAvailability = jest.fn((l: unknown) => {
      cloudCalls.push({ name: 'unsubscribe', args: [l] });
    });
  }
  return {
    __esModule: true,
    CloudStorage,
    CloudStorageScope: { AppData: 'app_data', Documents: 'documents' },
    CloudStorageProvider: { ICloud: 'icloud', GoogleDrive: 'googledrive' },
    CloudStorageError: MockCloudStorageError,
    CloudStorageErrorCode: {
      FILE_NOT_FOUND: 'ERR_FILE_NOT_FOUND',
      DIRECTORY_NOT_FOUND: 'ERR_DIRECTORY_NOT_FOUND',
      FILE_ALREADY_EXISTS: 'ERR_FILE_EXISTS',
    },
  };
});

// Kept OUTSIDE beforeEach's clearAllMocks. `ensureConfigured()` latches on
// module state, so configure() runs exactly once per process no matter how many
// tests need it — asserting on a cleared mock would just test test order.
const mockConfigureCalls: Record<string, unknown>[] = [];

const mockGsi = {
  configure: jest.fn((c: Record<string, unknown>) => { mockConfigureCalls.push(c); }),
  hasPlayServices: jest.fn(async () => true),
  hasPreviousSignIn: jest.fn(() => true),
  signIn: jest.fn(async () => ({ type: 'success' })),
  signInSilently: jest.fn(async () => ({ type: 'success' })),
  signOut: jest.fn(async () => undefined),
  getTokens: jest.fn(async () => ({ accessToken: 'ya29.fresh' })),
};
jest.mock('@react-native-google-signin/google-signin', () => ({ GoogleSignin: mockGsi }));

jest.mock('@/lib/config/endpoints', () => ({
  GOOGLE_WEB_CLIENT_ID: 'web-client-id',
  GOOGLE_IOS_CLIENT_ID: 'ios-client-id',
}));

let mockPlatformOS = 'ios';
jest.mock('react-native', () => ({
  get Platform() {
    return { OS: mockPlatformOS, select: (o: Record<string, unknown>) => o[mockPlatformOS] };
  },
}));

import { googleDriveProvider, disconnectGoogleDrive } from '../providers/google-drive';
import { icloudProvider, subscribeToICloudAvailability } from '../providers/icloud';
import { REMOTE_DIRECTORY } from '../providers/shared';

function callsTo(name: string) {
  return cloudCalls.filter((c) => c.name === name);
}

beforeEach(() => {
  cloudCalls.length = 0;
  mockExists = true;
  mockReaddir = [];
  mockThrowOn = null;
  mockPlatformOS = 'ios';
  jest.clearAllMocks();
  mockGsi.hasPreviousSignIn.mockReturnValue(true);
  mockGsi.signInSilently.mockResolvedValue({ type: 'success' });
  mockGsi.getTokens.mockResolvedValue({ accessToken: 'ya29.fresh' });
});

describe('the CloudStorage argument traps', () => {
  it('uploads REMOTE-first, because the library inverts the port order', async () => {
    await icloudProvider.upload('/local/blob.bin', `${REMOTE_DIRECTORY}/b1.bin`);
    const [call] = callsTo('uploadFile');
    expect(call.args[0]).toBe(`${REMOTE_DIRECTORY}/b1.bin`);
    expect(call.args[1]).toBe('/local/blob.bin');
    expect(call.args[2]).toEqual({ mimeType: 'application/octet-stream' });
  });

  it('downloads with THREE arguments, so the copying overload is the one that matches', async () => {
    // Two arguments resolves to `downloadFile(path, scope?)`, which only
    // triggers an iCloud sync. It copies nothing and resolves happily, so the
    // symptom is an empty local file rather than an error.
    await icloudProvider.download(`${REMOTE_DIRECTORY}/b1.bin`, '/local/blob.bin');
    const [call] = callsTo('downloadFile');
    expect(call.args).toHaveLength(3);
    expect(call.args[1]).toBe('/local/blob.bin');
    expect(call.args[2]).toBe('app_data');
  });

  it('never reaches for the string-only readFile/writeFile', async () => {
    await icloudProvider.upload('/local/blob.bin', `${REMOTE_DIRECTORY}/b1.bin`);
    await icloudProvider.download(`${REMOTE_DIRECTORY}/b1.bin`, '/local/blob.bin');
    // A 25 MB blob through either would be base64'd into JS memory whole.
    expect(callsTo('writeFile')).toHaveLength(0);
    expect(callsTo('readFile')).toHaveLength(0);
  });

  it('scopes every operation to app-data, not the user-visible Documents', async () => {
    mockReaddir = ['b1.bin'];
    await icloudProvider.list('b');
    await icloudProvider.remove(`${REMOTE_DIRECTORY}/b1.bin`);
    for (const call of cloudCalls) {
      if (call.name === 'setProviderOptions' || call.name === 'subscribe') continue;
      expect(call.args).toContain('app_data');
    }
  });
});

describe('iCloud availability is a runtime question', () => {
  it('is false off iOS without asking CloudKit', async () => {
    mockPlatformOS = 'android';
    expect(await icloudProvider.isAvailable()).toBe(false);
    expect(callsTo('isCloudAvailable')).toHaveLength(0);
  });

  it('asks CloudKit on iOS rather than inferring from the platform', async () => {
    // An iPhone with iCloud switched off is still an iPhone.
    expect(await icloudProvider.isAvailable()).toBe(true);
    expect(callsTo('isCloudAvailable')).toHaveLength(1);
  });

  it('reports unavailable rather than throwing at a settings screen', async () => {
    mockThrowOn = { method: 'isCloudAvailable', code: 'ERR_UNKNOWN' };
    expect(await icloudProvider.isAvailable()).toBe(false);
  });

  it('subscribes and hands back an unsubscribe', () => {
    // The method is subscribeToCloudAvailability, NOT the
    // onCloudAvailabilityChanged the plan named — that does not exist.
    const listener = jest.fn();
    const off = subscribeToICloudAvailability(listener);
    expect(callsTo('subscribe')).toHaveLength(1);
    off();
    expect(callsTo('unsubscribe')).toHaveLength(1);
  });
});

describe('Drive availability is a TOKEN question, not a CloudKit one', () => {
  it('never calls isCloudAvailable, which is hardcoded true for this provider', async () => {
    await googleDriveProvider.isAvailable();
    expect(callsTo('isCloudAvailable')).toHaveLength(0);
  });

  it('is available when a silent sign-in yields an access token', async () => {
    expect(await googleDriveProvider.isAvailable()).toBe(true);
  });

  it('is unavailable when nobody has ever connected Drive', async () => {
    mockGsi.hasPreviousSignIn.mockReturnValue(false);
    expect(await googleDriveProvider.isAvailable()).toBe(false);
    // And it must NOT pop an account chooser to find that out.
    expect(mockGsi.signIn).not.toHaveBeenCalled();
  });

  it('is unavailable when the saved credential no longer resolves', async () => {
    mockGsi.signInSilently.mockResolvedValue({ type: 'noSavedCredentialFound' });
    expect(await googleDriveProvider.isAvailable()).toBe(false);
  });

  it('installs a FRESH token before every operation, not once at configure', async () => {
    // The token is short-lived. Minting it at connect time passes testing and
    // dies mid-session, which is the lesson lib/intercom.ts already paid for.
    mockGsi.getTokens.mockResolvedValueOnce({ accessToken: 'token-1' });
    await googleDriveProvider.upload('/local/a.bin', `${REMOTE_DIRECTORY}/a.bin`);
    mockGsi.getTokens.mockResolvedValueOnce({ accessToken: 'token-2' });
    await googleDriveProvider.upload('/local/b.bin', `${REMOTE_DIRECTORY}/b.bin`);

    expect(callsTo('setProviderOptions').map((c) => (c.args[0] as { accessToken: string }).accessToken))
      .toEqual(['token-1', 'token-2']);
  });

  it('refuses with provider-unavailable rather than uploading tokenless', async () => {
    mockGsi.hasPreviousSignIn.mockReturnValue(false);
    await expect(
      googleDriveProvider.upload('/local/a.bin', `${REMOTE_DIRECTORY}/a.bin`),
    ).rejects.toMatchObject({ reason: 'provider-unavailable' });
    expect(callsTo('uploadFile')).toHaveLength(0);
  });

  it('asks only for drive.appdata, which cannot read the user own Drive files', async () => {
    await googleDriveProvider.isAvailable();
    expect(mockConfigureCalls[0]).toMatchObject({
      scopes: ['https://www.googleapis.com/auth/drive.appdata'],
    });
  });

  it('passes no android client id — that client is matched by package plus SHA-1', async () => {
    await googleDriveProvider.isAvailable();
    const config = mockConfigureCalls[0];
    expect(config).not.toHaveProperty('androidClientId');
    expect(config.webClientId).toBe('web-client-id');
  });

  it('disconnects without touching the app session', async () => {
    await disconnectGoogleDrive();
    expect(mockGsi.signOut).toHaveBeenCalled();
    // revokeAccess would also drop the grant, which is a different and more
    // destructive thing than "this device stops using Drive".
    expect(mockGsi).not.toHaveProperty('revokeAccessCalled');
  });

  it('a disconnect that throws is swallowed, because clearAuthStorage awaits it', async () => {
    mockGsi.signOut.mockRejectedValueOnce(new Error('no network'));
    await expect(disconnectGoogleDrive()).resolves.toBeUndefined();
  });
});

describe('failure mapping', () => {
  it('reports a missing file as not-found', async () => {
    mockThrowOn = { method: 'downloadFile', code: 'ERR_FILE_NOT_FOUND' };
    await expect(
      icloudProvider.download(`${REMOTE_DIRECTORY}/gone.bin`, '/local/x.bin'),
    ).rejects.toMatchObject({ reason: 'not-found' });
  });

  it('reports everything else as provider-unavailable, never as a missing backup', async () => {
    // Quota, an expired token and a dead network are one situation from the
    // user's side: try again later. Calling any of them not-found would tell
    // them their backup is gone.
    mockThrowOn = { method: 'uploadFile', code: 'ERR_WRITE_ERROR' };
    await expect(
      icloudProvider.upload('/local/a.bin', `${REMOTE_DIRECTORY}/a.bin`),
    ).rejects.toMatchObject({ reason: 'provider-unavailable' });
  });

  it('treats an absent backup directory as no backups, not as an error', async () => {
    mockExists = false;
    expect(await icloudProvider.list('mera-backup')).toEqual([]);
  });

  it('treats deleting an already-gone file as success', async () => {
    mockThrowOn = { method: 'unlink', code: 'ERR_FILE_NOT_FOUND' };
    await expect(icloudProvider.remove(`${REMOTE_DIRECTORY}/gone.bin`)).resolves.toBeUndefined();
  });

  it('does not re-create a directory that is already there', async () => {
    mockExists = true;
    await icloudProvider.upload('/local/a.bin', `${REMOTE_DIRECTORY}/a.bin`);
    expect(callsTo('mkdir')).toHaveLength(0);
  });

  it('creates the directory on the first upload', async () => {
    mockExists = false;
    await icloudProvider.upload('/local/a.bin', `${REMOTE_DIRECTORY}/a.bin`);
    expect(callsTo('mkdir')).toHaveLength(1);
  });
});

describe('listing', () => {
  it('filters by prefix and returns full remote paths', async () => {
    mockExists = true;
    mockReaddir = ['mera-backup-2.bin', 'mera-backup-1.bin', 'something-else.txt'];
    expect(await icloudProvider.list('mera-backup')).toEqual([
      `${REMOTE_DIRECTORY}/mera-backup-1.bin`,
      `${REMOTE_DIRECTORY}/mera-backup-2.bin`,
    ]);
  });
});
