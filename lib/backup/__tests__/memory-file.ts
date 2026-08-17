// A grow-on-write buffer standing in for a file, satisfying BlobSink,
// BlobSource and ScratchFile.
//
// Not a `.test.ts`, so jest's testMatch does not collect it. Shared by the blob,
// export and import suites so all three exercise the codec against IDENTICAL
// positional semantics — three hand-rolled copies would be three chances for
// one of them to quietly differ from the RNFS adapter it stands in for.

import type { BlobSink, BlobSource } from '../blob';
import type { ScratchFile } from '../export';

export class MemoryFile implements BlobSink, BlobSource, ScratchFile {
  bytes = new Uint8Array(0);

  write(data: Uint8Array, position: number): Promise<void> {
    const end = position + data.length;
    if (end > this.bytes.length) {
      const grown = new Uint8Array(end);
      grown.set(this.bytes, 0);
      this.bytes = grown;
    }
    this.bytes.set(data, position);
    return Promise.resolve();
  }

  read(length: number, position: number): Promise<Uint8Array> {
    return Promise.resolve(this.bytes.slice(position, position + length));
  }

  size(): Promise<number> {
    return Promise.resolve(this.bytes.length);
  }
}
