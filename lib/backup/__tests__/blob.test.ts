// The four attacks the plan names, plus the ones the STREAM nonce exists for.
//
// A per-frame AEAD alone catches a tampered byte. It does NOT catch a blob cut
// short, frames put back in the wrong order, or a frame lifted from a different
// backup — those are what the counter, the last-frame flag and the per-blob
// nonce prefix are for, and each gets its own test here.
//
// IO is an in-memory buffer, which is the point of injecting it: this exercises
// the real codec with no native module and no device.

import { BlobFormatError, BlobWriter, openBlob, type BlobSink, type BlobSource } from '../blob';
import { BACKUP_FORMAT_VERSION, type BackupHeader } from '../types';

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const OTHER_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 99);
const PREFIX = Uint8Array.from({ length: 19 }, (_, i) => i);

const HEADER: BackupHeader = {
  formatVersion: BACKUP_FORMAT_VERSION,
  algo: 'recovery-code-v1',
  schemaVersion: 53,
  appVersion: '1.3.0',
  createdAt: 1_755_000_000_000,
  tables: [{ table: 'facts', rows: 2, rowsAvailable: 2 }],
  plaintextBytes: 12,
};

/** Grow-on-write buffer standing in for a file. */
class MemoryBlob implements BlobSink, BlobSource {
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

function readU32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

const FRAMES = [
  new TextEncoder().encode('first frame'),
  new TextEncoder().encode('second frame'),
  new TextEncoder().encode('third and last'),
];

async function writeBlob(frames = FRAMES): Promise<MemoryBlob> {
  const blob = new MemoryBlob();
  const w = new BlobWriter(KEY, blob, HEADER, PREFIX);
  for (let i = 0; i < frames.length; i++) {
    await w.writeFrame(frames[i], i === frames.length - 1);
  }
  return blob;
}

async function collect(blob: MemoryBlob, key = KEY): Promise<string[]> {
  const opened = await openBlob(key, blob);
  const out: string[] = [];
  for await (const f of opened.frames()) out.push(new TextDecoder().decode(f));
  return out;
}

async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof BlobFormatError) return err.reason;
    throw err;
  }
  throw new Error('expected a BlobFormatError, but it opened cleanly');
}

describe('round trip', () => {
  it('reads back every frame in order', async () => {
    expect(await collect(await writeBlob())).toEqual([
      'first frame',
      'second frame',
      'third and last',
    ]);
  });

  it('exposes the header without decrypting anything', async () => {
    const opened = await openBlob(KEY, await writeBlob());
    expect(opened.header.schemaVersion).toBe(53);
    expect(opened.header.appVersion).toBe('1.3.0');
    expect(opened.header.tables[0].table).toBe('facts');
  });

  it('does not leak the nonce prefix into the parsed header', async () => {
    const opened = await openBlob(KEY, await writeBlob());
    expect(opened.header as unknown as Record<string, unknown>).not.toHaveProperty('noncePrefix');
  });

  it('handles a single-frame blob, where the first frame is also the last', async () => {
    expect(await collect(await writeBlob([FRAMES[0]]))).toEqual(['first frame']);
  });

  it('handles an empty final frame', async () => {
    const blob = await writeBlob([FRAMES[0], new Uint8Array(0)]);
    expect(await collect(blob)).toEqual(['first frame', '']);
  });
});

describe('the refusals — including the three a per-frame AEAD alone misses', () => {
  it('tamper a header byte → fails', async () => {
    const blob = await writeBlob();
    blob.bytes[10] ^= 0xff; // inside the header JSON, past the length prefix
    // Either the JSON stops parsing, or it parses and every frame fails its AAD.
    // Both are refusals; which one depends on which byte moved.
    expect(['tampered', 'wrong-key']).toContain(await refusal(() => collect(blob)));
  });

  it('tamper a ciphertext byte → fails', async () => {
    const blob = await writeBlob();
    blob.bytes[blob.bytes.length - 1] ^= 0xff;
    expect(['tampered', 'wrong-key']).toContain(await refusal(() => collect(blob)));
  });

  it('drop the last frame → incomplete, which a per-frame AEAD would wave through', async () => {
    const full = await writeBlob();
    const truncated = new MemoryBlob();
    // Every surviving frame still authenticates perfectly. Only the missing
    // last-frame FLAG reveals the truncation.
    await truncated.write(full.bytes.slice(0, full.bytes.length - 40), 0);
    expect(await refusal(() => collect(truncated))).toBe('incomplete');
  });

  it('swap two frames → fails, because the counter is authenticated', async () => {
    // Equal-length plaintexts so the regions can be exchanged byte for byte —
    // a real physical swap, not a re-seal.
    const a = new TextEncoder().encode('AAAAAAAA');
    const b = new TextEncoder().encode('BBBBBBBB');
    const blob = await writeBlob([a, b]);

    const headerLen = readU32(blob.bytes, 0);
    const f0 = 4 + headerLen;
    const ctLen = readU32(blob.bytes, f0);
    const f1 = f0 + 4 + ctLen;

    const ct0 = blob.bytes.slice(f0 + 4, f0 + 4 + ctLen);
    const ct1 = blob.bytes.slice(f1 + 4, f1 + 4 + ctLen);
    blob.bytes.set(ct1, f0 + 4);
    blob.bytes.set(ct0, f1 + 4);

    expect(await refusal(() => collect(blob))).not.toBe('');
  });

  it('splice a frame in from a different blob → fails on the per-blob nonce prefix', async () => {
    // Same key, same plaintext, same frame index. ONLY the nonce prefix differs,
    // which is the single thing standing between two of a user's own backups.
    const donor = new MemoryBlob();
    const donorPrefix = Uint8Array.from({ length: 19 }, (_, i) => i + 50);
    const dw = new BlobWriter(KEY, donor, HEADER, donorPrefix);
    await dw.writeFrame(FRAMES[0], false);
    await dw.writeFrame(FRAMES[1], true);

    const victim = await writeBlob([FRAMES[0], FRAMES[1]]);
    const headerLen = readU32(victim.bytes, 0);
    const at = 4 + headerLen;
    const ctLen = readU32(victim.bytes, at);
    const donorAt = 4 + readU32(donor.bytes, 0);

    victim.bytes.set(donor.bytes.slice(donorAt + 4, donorAt + 4 + ctLen), at + 4);
    expect(await refusal(() => collect(victim))).toBe('wrong-key');
  });

  it('wrong key → wrong-key, distinguishable from tampering', async () => {
    const blob = await writeBlob();
    expect(await refusal(() => collect(blob, OTHER_KEY))).toBe('wrong-key');
  });
});

describe('format and shape guards', () => {
  it('refuses a file too small to hold a header', async () => {
    const blob = new MemoryBlob();
    await blob.write(Uint8Array.from([0, 0]), 0);
    expect(await refusal(() => openBlob(KEY, blob))).toBe('incomplete');
  });

  it('refuses a header length that runs past EOF', async () => {
    const blob = new MemoryBlob();
    await blob.write(Uint8Array.from([0xff, 0xff, 0xff, 0xff]), 0);
    await blob.write(new Uint8Array(8), 4);
    expect(await refusal(() => openBlob(KEY, blob))).toBe('incomplete');
  });

  it('refuses a newer format version rather than guessing at it', async () => {
    const blob = new MemoryBlob();
    const future = JSON.stringify({
      ...HEADER,
      formatVersion: BACKUP_FORMAT_VERSION + 1,
      noncePrefix: btoa('x'.repeat(19)),
    });
    const bytes = new TextEncoder().encode(future);
    await blob.write(Uint8Array.from([0, 0, (bytes.length >> 8) & 0xff, bytes.length & 0xff]), 0);
    await blob.write(bytes, 4);
    expect(await refusal(() => openBlob(KEY, blob))).toBe('format-too-new');
  });

  it('refuses a header that is not JSON', async () => {
    const blob = new MemoryBlob();
    const junk = new TextEncoder().encode('not json at all');
    await blob.write(Uint8Array.from([0, 0, 0, junk.length]), 0);
    await blob.write(junk, 4);
    expect(await refusal(() => openBlob(KEY, blob))).toBe('tampered');
  });
});

describe('writer contract', () => {
  it('refuses to write after the final frame', async () => {
    const blob = new MemoryBlob();
    const w = new BlobWriter(KEY, blob, HEADER, PREFIX);
    await w.writeFrame(FRAMES[0], true);
    await expect(w.writeFrame(FRAMES[1], false)).rejects.toThrow('after the final frame');
  });

  it('reports bytes written so the exporter can enforce the size cap', async () => {
    const blob = new MemoryBlob();
    const w = new BlobWriter(KEY, blob, HEADER, PREFIX);
    expect(w.bytesWritten).toBe(0);
    await w.writeFrame(FRAMES[0], true);
    expect(w.bytesWritten).toBe(blob.bytes.length);
    expect(w.wroteFinalFrame).toBe(true);
  });

  it('uses a different nonce prefix per blob when not injected', async () => {
    const a = new MemoryBlob();
    const b = new MemoryBlob();
    await new BlobWriter(KEY, a, HEADER).writeFrame(FRAMES[0], true);
    await new BlobWriter(KEY, b, HEADER).writeFrame(FRAMES[0], true);
    // Identical key and plaintext; the ciphertexts must still differ.
    expect(Array.from(a.bytes)).not.toEqual(Array.from(b.bytes));
  });
});
