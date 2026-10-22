// In-memory `expo-file-system` (the new File / Directory / Paths API), for the on-device chat path:
// modelManager.initBaseModel refuses to load a model whose file does not exist.
//
// expo-* is a mockable native edge. Install it per test file, explicitly:
//   jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
// and call resetFileSystem() in beforeEach.

const files = new Map<string, string>();
const dirs = new Set<string>();

type PathPart = string | { uri: string };

function join(parts: PathPart[]): string {
  return parts
    .map((p, i) => {
      const s = typeof p === 'string' ? p : p.uri;
      return i === 0 ? s.replace(/\/+$/, '') : s.replace(/^\/+|\/+$/g, '');
    })
    .join('/');
}

class FakeFile {
  readonly uri: string;
  constructor(...parts: PathPart[]) {
    this.uri = join(parts);
  }
  get name(): string {
    return this.uri.split('/').pop() ?? '';
  }
  get exists(): boolean {
    return files.has(this.uri);
  }
  get size(): number {
    return files.get(this.uri)?.length ?? 0;
  }
  async text(): Promise<string> {
    const v = files.get(this.uri);
    if (v === undefined) throw new Error(`no such file: ${this.uri}`);
    return v;
  }
  async write(content: string): Promise<void> {
    files.set(this.uri, content);
  }
  async info(): Promise<{ exists: boolean; size?: number; uri: string }> {
    return { exists: this.exists, size: this.exists ? this.size : undefined, uri: this.uri };
  }
  create(): void {
    if (!files.has(this.uri)) files.set(this.uri, '');
  }
  /** A read handle, as expo's FileHandle: `readBytes(n)` from the start, one char per byte. */
  open(): { readBytes: (length: number) => Uint8Array; close: () => void } {
    const content = files.get(this.uri);
    if (content === undefined) throw new Error(`no such file: ${this.uri}`);
    let offset = 0;
    return {
      readBytes: (length: number) => {
        const out = Uint8Array.from(content.slice(offset, offset + length), (c) => c.charCodeAt(0));
        offset += out.length;
        return out;
      },
      close: () => {},
    };
  }
  delete(): void {
    files.delete(this.uri);
  }
}

class FakeDirectory {
  readonly uri: string;
  constructor(...parts: PathPart[]) {
    this.uri = join(parts);
  }
  get name(): string {
    return this.uri.split('/').pop() ?? '';
  }
  get exists(): boolean {
    const prefix = `${this.uri}/`;
    return dirs.has(this.uri) || [...files.keys(), ...dirs].some((k) => k.startsWith(prefix));
  }
  async create(): Promise<void> {
    dirs.add(this.uri);
  }
  async delete(): Promise<void> {
    const prefix = `${this.uri}/`;
    dirs.delete(this.uri);
    for (const k of [...files.keys()]) if (k.startsWith(prefix)) files.delete(k);
    for (const k of [...dirs]) if (k.startsWith(prefix)) dirs.delete(k);
  }
  list(): (FakeFile | FakeDirectory)[] {
    const prefix = `${this.uri}/`;
    const names = new Set<string>();
    for (const k of [...files.keys(), ...dirs]) {
      if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0]);
    }
    return [...names].map((n) =>
      files.has(`${prefix}${n}`) ? new FakeFile(this, n) : new FakeDirectory(this, n),
    );
  }
}

export const fileSystemModule = {
  __esModule: true,
  File: FakeFile,
  Directory: FakeDirectory,
  Paths: {
    cache: new FakeDirectory('file:///cache'),
    document: new FakeDirectory('file:///document'),
  },
};

export function resetFileSystem(): void {
  files.clear();
  dirs.clear();
}

/** Puts a model file where modelManager looks for it (`<cache>/mera-models/<id>/model.gguf`). */
export function placeModelFile(modelId: string): void {
  files.set(new FakeFile(fileSystemModule.Paths.cache, 'mera-models', modelId, 'model.gguf').uri, 'GGUF');
}

/** A model as a finished download leaves it: the file AND the ready manifest `isModelDownloaded` reads. */
export function placeDownloadedModel(modelId: string): void {
  placeModelFile(modelId);
  files.set(
    new FakeFile(fileSystemModule.Paths.cache, 'mera-models', modelId, 'manifest.json').uri,
    JSON.stringify({ modelId, version: '1.0.0', sizeBytes: 4, quantization: 'Q4_K_M', downloadedAt: '2026-10-19T00:00:00Z', ready: true }),
  );
}
