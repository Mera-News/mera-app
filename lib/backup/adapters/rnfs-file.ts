// The RNFS-backed file, satisfying `BlobSink`, `BlobSource` and `ScratchFile`.
//
// `RNFS.write(path, data, position, 'base64')` places bytes at a BYTE offset on
// both platforms — verified on device 2026-08-17 by `dev-probe.ts` (iOS 26.5.2,
// three frames of 7/11/5 bytes, none a multiple of 3, byte-exact round trip
// plus a matching native sha256) and by reading the Android implementation,
// which does `Base64.decode` then `RandomAccessFile.seek`. That is the whole
// reason the codec can write frames sequentially by position.
//
// This file is native-coupled on purpose and nothing in the backup CORE
// (`types`, `allowlist`, `crypto`, `blob`, `export`, `import`) may import it.
// The core takes its IO through injected ports so it stays testable in Node.

import * as RNFS from '@dr.pogodin/react-native-fs';

import { base64ToBytes, bytesToBase64 } from '../base64';
import type { BlobSink, BlobSource } from '../blob';
import type { ScratchFile } from '../export';

export class RnfsFile implements BlobSink, BlobSource, ScratchFile {
  constructor(readonly path: string) {}

  /**
   * Truncates to empty, creating the file if absent. Every writer starts from a
   * known-empty file so byte offsets are unambiguous — appending into whatever
   * a previous aborted run left behind is how a blob acquires a valid prefix
   * and a garbage tail.
   */
  static async createEmpty(path: string): Promise<RnfsFile> {
    await RNFS.writeFile(path, '', 'base64');
    return new RnfsFile(path);
  }

  async write(bytes: Uint8Array, position: number): Promise<void> {
    if (bytes.length === 0) return;
    await RNFS.write(this.path, bytesToBase64(bytes), position, 'base64');
  }

  async read(length: number, position: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0);
    const b64 = await RNFS.read(this.path, length, position, 'base64');
    return base64ToBytes(b64);
  }

  async size(): Promise<number> {
    const stat = await RNFS.stat(this.path);
    return Number(stat.size);
  }

  /** Best-effort. A failed cleanup must never mask the error that caused it. */
  async remove(): Promise<void> {
    try {
      if (await RNFS.exists(this.path)) await RNFS.unlink(this.path);
    } catch {
      // deliberately swallowed
    }
  }
}
