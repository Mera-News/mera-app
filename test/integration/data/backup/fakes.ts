// Native-edge fakes for the backup seam tests (data-U12). Not a test file.
//
// Two edges the shared setup mocks too thinly to drive a backup through:
//   - `@dr.pogodin/react-native-fs`: the setup mock has no writeFile / write / read, which
//     `RnfsFile` needs. Here it is a byte store keyed by path, with the same BYTE-offset
//     semantics `rnfs-file.ts` documents.
//   - `react-native-cloud-storage`: the setup mock is a no-op class. Here it is a remote that
//     keeps bytes, so an upload really arrives and a download really copies, and the two
//     `downloadFile` overloads behave like the library's (the 2-argument one copies nothing).
//
// Install per test file:
//   jest.mock('@dr.pogodin/react-native-fs', () => require('./fakes').rnfsModule);
//   jest.mock('react-native-cloud-storage', () => require('./fakes').cloudStorageModule);
//
// State lives on `globalThis` so a `jest.isolateModules` registry (used for the Drive provider,
// whose module state cannot be reset) sees the same disk and the same remote as the test body.

export interface CloudCall {
  readonly name: string;
  readonly args: unknown[];
  readonly provider: string;
  readonly accessToken?: string;
}

interface Shared {
  /** The device filesystem as RNFS sees it: path -> bytes. */
  disk: Map<string, Uint8Array>;
  /** Every path `writeFile` ever created, in order, even after the file was removed. */
  created: string[];
  /** One remote per provider: remote path -> bytes. */
  remotes: Map<string, Map<string, Uint8Array>>;
  dirs: Map<string, Set<string>>;
  calls: CloudCall[];
  /** Every call to this method throws a CloudStorageError with this code until reset. */
  failOn: { method: string; code: string } | null;
  /** `unlink` throws for an existing file while set (a file the OS will not let go of). */
  failUnlink: boolean;
  /** What `isCloudAvailable()` answers. */
  icloudAvailable: boolean;
  listeners: Set<(available: boolean) => void>;
}

const g = globalThis as unknown as { __backupFakes?: Shared };
export const shared: Shared = (g.__backupFakes ??= {
  disk: new Map(),
  created: [],
  remotes: new Map(),
  dirs: new Map(),
  calls: [],
  failOn: null,
  failUnlink: false,
  icloudAvailable: true,
  listeners: new Set(),
});

export function resetFakes(): void {
  shared.disk.clear();
  shared.created.length = 0;
  shared.remotes.clear();
  shared.dirs.clear();
  shared.calls.length = 0;
  shared.failOn = null;
  shared.failUnlink = false;
  shared.icloudAvailable = true;
  shared.listeners.clear();
}

// ---- RNFS -----------------------------------------------------------------

const toBytes = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));
const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

function noSuchFile(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
}

export const rnfsModule = {
  DocumentDirectoryPath: '/tmp/mera-test',
  CachesDirectoryPath: '/tmp/mera-test-cache',
  writeFile: async (path: string, data: string, _encoding?: string): Promise<void> => {
    shared.created.push(path);
    shared.disk.set(path, toBytes(data));
  },
  write: async (path: string, data: string, position: number, _encoding?: string): Promise<void> => {
    const current = shared.disk.get(path);
    if (!current) throw noSuchFile(path);
    const bytes = toBytes(data);
    const end = position + bytes.length;
    const next = new Uint8Array(Math.max(current.length, end));
    next.set(current, 0);
    next.set(bytes, position);
    shared.disk.set(path, next);
  },
  read: async (path: string, length: number, position: number, _encoding?: string): Promise<string> => {
    const current = shared.disk.get(path);
    if (!current) throw noSuchFile(path);
    return toB64(current.slice(position, position + length));
  },
  stat: async (path: string): Promise<{ size: number }> => {
    const current = shared.disk.get(path);
    if (!current) throw noSuchFile(path);
    return { size: current.length };
  },
  exists: async (path: string): Promise<boolean> => shared.disk.has(path),
  unlink: async (path: string): Promise<void> => {
    if (shared.failUnlink) throw new Error('EBUSY: resource busy or locked');
    if (!shared.disk.delete(path)) throw noSuchFile(path);
  },
  mkdir: async (): Promise<void> => undefined,
};

// ---- react-native-cloud-storage -------------------------------------------

export const CloudStorageErrorCode = {
  FILE_NOT_FOUND: 'ERR_FILE_NOT_FOUND',
  DIRECTORY_NOT_FOUND: 'ERR_DIRECTORY_NOT_FOUND',
  FILE_ALREADY_EXISTS: 'ERR_FILE_EXISTS',
} as const;

export class CloudStorageError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.name = 'CloudStorageError';
    this.code = code;
  }
}

class CloudStorage {
  private options: { scope?: string; accessToken?: string };

  constructor(
    private readonly provider: string,
    options: { scope?: string; accessToken?: string } = {},
  ) {
    this.options = options;
  }

  private enter(name: string, args: unknown[]): Map<string, Uint8Array> {
    shared.calls.push({ name, args, provider: this.provider, accessToken: this.options.accessToken });
    if (shared.failOn?.method === name) throw new CloudStorageError(shared.failOn.code);
    // Drive refuses a call that carries no token, as the real API does.
    if (this.provider === 'googledrive' && name !== 'setProviderOptions' && !this.options.accessToken) {
      throw new CloudStorageError('ERR_UNAUTHENTICATED');
    }
    let remote = shared.remotes.get(this.provider);
    if (!remote) shared.remotes.set(this.provider, (remote = new Map()));
    return remote;
  }

  private dirsOf(): Set<string> {
    let dirs = shared.dirs.get(this.provider);
    if (!dirs) shared.dirs.set(this.provider, (dirs = new Set()));
    return dirs;
  }

  async isCloudAvailable(): Promise<boolean> {
    this.enter('isCloudAvailable', []);
    return shared.icloudAvailable;
  }

  async exists(path: string, scope?: string): Promise<boolean> {
    const remote = this.enter('exists', [path, scope]);
    return this.dirsOf().has(path) || remote.has(path);
  }

  async mkdir(path: string, scope?: string): Promise<void> {
    this.enter('mkdir', [path, scope]);
    if (this.dirsOf().has(path)) throw new CloudStorageError(CloudStorageErrorCode.FILE_ALREADY_EXISTS);
    this.dirsOf().add(path);
  }

  async uploadFile(remotePath: string, localPath: string, options?: unknown, scope?: string): Promise<void> {
    const remote = this.enter('uploadFile', [remotePath, localPath, options, scope]);
    const bytes = shared.disk.get(localPath);
    if (!bytes) throw new CloudStorageError(CloudStorageErrorCode.FILE_NOT_FOUND, `no local file ${localPath}`);
    remote.set(remotePath, bytes.slice());
  }

  /** `(path, scope?)` only triggers a sync and copies nothing; `(remote, local, scope?)` copies. */
  async downloadFile(...args: unknown[]): Promise<void> {
    const remote = this.enter('downloadFile', args);
    if (args.length < 3) return;
    const [remotePath, localPath] = args as [string, string];
    const bytes = remote.get(remotePath);
    if (!bytes) throw new CloudStorageError(CloudStorageErrorCode.FILE_NOT_FOUND, `no remote file ${remotePath}`);
    shared.disk.set(localPath, bytes.slice());
  }

  async readdir(path: string, scope?: string): Promise<string[]> {
    const remote = this.enter('readdir', [path, scope]);
    if (!this.dirsOf().has(path)) throw new CloudStorageError(CloudStorageErrorCode.DIRECTORY_NOT_FOUND);
    return [...remote.keys()].filter((k) => k.startsWith(`${path}/`)).map((k) => k.slice(path.length + 1));
  }

  async unlink(path: string, scope?: string): Promise<void> {
    const remote = this.enter('unlink', [path, scope]);
    if (!remote.delete(path)) throw new CloudStorageError(CloudStorageErrorCode.FILE_NOT_FOUND);
  }

  setProviderOptions(options: { scope?: string; accessToken?: string }): void {
    this.enter('setProviderOptions', [options]);
    this.options = { ...this.options, ...options };
  }

  subscribeToCloudAvailability(listener: (available: boolean) => void): void {
    this.enter('subscribe', []);
    shared.listeners.add(listener);
  }

  unsubscribeFromCloudAvailability(listener: (available: boolean) => void): void {
    this.enter('unsubscribe', []);
    shared.listeners.delete(listener);
  }
}

export const cloudStorageModule = {
  __esModule: true,
  CloudStorage,
  CloudStorageScope: { AppData: 'app_data', Documents: 'documents' },
  CloudStorageProvider: { ICloud: 'icloud', GoogleDrive: 'googledrive' },
  CloudStorageError,
  CloudStorageErrorCode,
};

/** Calls to one method, in order. */
export function callsTo(name: string): CloudCall[] {
  return shared.calls.filter((c) => c.name === name);
}

/** The remote paths currently held by a provider. */
export function remoteNames(provider: 'icloud' | 'googledrive' = 'icloud'): string[] {
  return [...(shared.remotes.get(provider)?.keys() ?? [])].sort();
}

/** Puts a blob straight into a provider's remote, creating its directory. */
export function putRemote(path: string, bytes: Uint8Array, provider: 'icloud' | 'googledrive' = 'icloud'): void {
  let remote = shared.remotes.get(provider);
  if (!remote) shared.remotes.set(provider, (remote = new Map()));
  remote.set(path, bytes);
  let dirs = shared.dirs.get(provider);
  if (!dirs) shared.dirs.set(provider, (dirs = new Set()));
  dirs.add(path.slice(0, path.lastIndexOf('/')));
}

export function remoteBytes(path: string, provider: 'icloud' | 'googledrive' = 'icloud'): Uint8Array | undefined {
  return shared.remotes.get(provider)?.get(path);
}
