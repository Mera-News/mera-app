// Dev-only probe for the two primitives the backup blob codec is built on.
//
// Neither has ever run in this repo, and both fail the same ugly way: not at
// write time with an error, but at RESTORE time with a blob that will not open.
// So they get proven on a device before `blob.ts` is designed around them,
// rather than after.
//
// **This module ships in the bundle but is only reachable behind `__DEV__`.**
// It writes exclusively under `Paths.document/backup-probe/` and deletes that
// directory when it finishes, including on failure.
//
// It reports FAILURE loudly and never partially. A probe that half-works and
// says "ok" is worse than no probe, because the whole point is to justify a
// design decision.

import { Directory, Paths } from 'expo-file-system';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { sha256 } from '@noble/hashes/sha2.js';
import pako from 'pako';
import { Platform } from 'react-native';

export interface ProbeCheck {
  readonly name: string;
  readonly pass: boolean;
  /** What was observed, in enough detail to design against. */
  readonly detail: string;
}

export interface ProbeReport {
  readonly platform: string;
  readonly checks: readonly ProbeCheck[];
  readonly allPassed: boolean;
  /** Set when the probe itself blew up rather than a check failing. */
  readonly error?: string;
}

const PROBE_DIR = 'backup-probe';

// ---- small helpers -------------------------------------------------------
// Loop-based rather than String.fromCharCode(...bytes): the spread form blows
// the argument limit on anything large, and the blob codec will hand these real
// frame sizes later.

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- probe 1: RNFS.write at a byte offset ---------------------------------

/**
 * The frame lengths are chosen to be hostile on purpose: 7, 11 and 5 bytes, none
 * a multiple of 3.
 *
 * That matters because base64 encodes in 3-byte groups. The JS layer is a
 * pass-through — `encode(datum, 'base64')` returns `datum` unchanged
 * (`@dr.pogodin/react-native-fs/src/utils.ts:79-80`) — so the whole question is
 * what native does with `position`. If it decodes and writes bytes at a byte
 * offset, these round-trip exactly. If it instead treats `position` as an offset
 * into the base64 TEXT, each frame's `=` padding lands mid-stream and every frame
 * after the first is corrupt. Multiple-of-3 frames would hide that completely.
 */
async function probeWriteAtOffset(dir: string): Promise<ProbeCheck[]> {
  const path = `${dir}/frames.bin`;
  const frames = [
    Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
    Uint8Array.from([0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b]),
    Uint8Array.from([0xf1, 0xf2, 0xf3, 0xf4, 0xf5]),
  ];
  const expected = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let off = 0;
  for (const f of frames) {
    expected.set(f, off);
    off += f.length;
  }

  // Start from a known-empty file so offsets are unambiguous.
  await RNFS.writeFile(path, '', 'base64');

  let position = 0;
  for (const f of frames) {
    await RNFS.write(path, bytesToB64(f), position, 'base64');
    position += f.length;
  }

  const readBackB64 = await RNFS.read(path, expected.length, 0, 'base64');
  const readBack = b64ToBytes(readBackB64);

  const byteExact = eq(readBack, expected);
  const checks: ProbeCheck[] = [
    {
      name: 'RNFS.write at position > 0 round-trips byte-exact',
      pass: byteExact,
      detail: byteExact
        ? `wrote 3 frames (7+11+5=${expected.length}B) at offsets 0/7/18, read back identical`
        : `MISMATCH — expected ${expected.length}B ${hex(expected)}, got ${readBack.length}B ${hex(readBack)}`,
    },
  ];

  // Independent confirmation: the NATIVE hash of the file must match a hash the
  // JS side computed over what it believes it wrote. Reading back through the
  // same base64 path that wrote it could hide a symmetric bug; this cannot.
  const nativeHash = (await RNFS.hash(path, 'sha256')).toLowerCase();
  const jsHash = hex(sha256(expected));
  checks.push({
    name: 'native sha256 of the file matches the JS hash of the intended bytes',
    pass: nativeHash === jsHash,
    detail:
      nativeHash === jsHash
        ? `both ${jsHash.slice(0, 16)}…`
        : `MISMATCH — native ${nativeHash}, expected ${jsHash}`,
  });

  // Partial read at an offset, which the importer will do frame by frame.
  const midB64 = await RNFS.read(path, 11, 7, 'base64');
  const mid = b64ToBytes(midB64);
  const midOk = eq(mid, frames[1]);
  checks.push({
    name: 'RNFS.read(length, position) returns exactly that slice',
    pass: midOk,
    detail: midOk
      ? 'read(11B @ offset 7) returned frame 2 exactly'
      : `MISMATCH — expected ${hex(frames[1])}, got ${hex(mid)}`,
  });

  return checks;
}

// ---- probe 2: pako streaming under Hermes ---------------------------------

/**
 * The repo only ever uses one-shot `pako.gzip`, so `push()` + `onData` has no
 * precedent here. Two separate questions, and the second is the one that decides
 * the frame design:
 *
 *   1. Does a chunked deflate → chunked inflate round-trip byte-exactly?
 *   2. Does `onData` fire INCREMENTALLY, or does everything arrive in one
 *      callback at the final `push(…, true)`?
 *
 * If (2) is "one callback at the end", pako is buffering the whole stream and
 * the memory win that motivates framing is imaginary — the frame boundary then
 * has to come from somewhere else, and that is a design change, not a workaround.
 */
export function probePakoStreaming(): ProbeCheck[] {
  // The source must be INCOMPRESSIBLE, and that is the whole subtlety of this
  // check. A patterned 512 KB source deflates to ~15 KB — under pako's 16 KB
  // output chunk — so it legitimately emits ONE onData and the probe would
  // report "buffered" when pako was behaving perfectly. Measured: that exact
  // false negative happened on the first version of this probe.
  //
  // A deterministic LCG gives ~1:1 deflate output, so 512 KB in means ~32 output
  // chunks, and the onData cadence becomes a real signal instead of an artefact
  // of how squashable the fixture was. Deterministic rather than Math.random so
  // two runs are comparable.
  const CHUNK = 64 * 1024;
  const CHUNKS = 8;
  const source = new Uint8Array(CHUNK * CHUNKS);
  let lcg = 0x2545f491;
  for (let i = 0; i < source.length; i++) {
    lcg = (Math.imul(lcg, 1664525) + 1013904223) >>> 0;
    source[i] = (lcg >>> 24) & 0xff;
  }

  const deflated: Uint8Array[] = [];
  let onDataCallsBeforeFinal = 0;
  const deflate = new pako.Deflate({ level: 6 });
  deflate.onData = (chunk: Uint8Array) => {
    deflated.push(chunk);
  };

  for (let i = 0; i < CHUNKS; i++) {
    const isLast = i === CHUNKS - 1;
    if (!isLast) {
      deflate.push(source.subarray(i * CHUNK, (i + 1) * CHUNK), false);
      onDataCallsBeforeFinal = deflated.length;
    } else {
      deflate.push(source.subarray(i * CHUNK), true);
    }
  }

  if (deflate.err) {
    return [
      {
        name: 'pako.Deflate streaming',
        pass: false,
        detail: `deflate error ${deflate.err}: ${deflate.msg}`,
      },
    ];
  }

  const totalDeflated = deflated.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(totalDeflated);
  let o = 0;
  for (const c of deflated) {
    joined.set(c, o);
    o += c.length;
  }

  // Inflate in chunks too — the importer will feed it frame by frame.
  const inflated: Uint8Array[] = [];
  const inflate = new pako.Inflate();
  inflate.onData = (chunk: Uint8Array) => {
    inflated.push(chunk);
  };
  const IN_CHUNK = 16 * 1024;
  for (let i = 0; i < joined.length; i += IN_CHUNK) {
    const isLast = i + IN_CHUNK >= joined.length;
    inflate.push(joined.subarray(i, Math.min(i + IN_CHUNK, joined.length)), isLast);
  }

  if (inflate.err) {
    return [
      {
        name: 'pako.Inflate streaming',
        pass: false,
        detail: `inflate error ${inflate.err}: ${inflate.msg}`,
      },
    ];
  }

  const totalInflated = inflated.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(totalInflated);
  o = 0;
  for (const c of inflated) {
    out.set(c, o);
    o += c.length;
  }

  const roundTrip = eq(out, source);
  const incremental = onDataCallsBeforeFinal > 0;

  return [
    {
      name: 'pako chunked deflate → chunked inflate round-trips byte-exact',
      pass: roundTrip,
      detail: roundTrip
        ? `${source.length}B → ${totalDeflated}B → ${totalInflated}B, identical`
        : `MISMATCH — ${source.length}B in, ${totalInflated}B out`,
    },
    {
      name: 'pako onData fires INCREMENTALLY, not once at the final push',
      pass: incremental,
      detail: incremental
        ? `${onDataCallsBeforeFinal} onData call(s) before the final push, ${deflated.length} total — genuinely streaming`
        : `BUFFERED — 0 onData calls before the final push (${deflated.length} total). The streaming memory win is imaginary; the frame boundary needs redesigning, NOT working around.`,
    },
  ];
}

// ---- entry point ----------------------------------------------------------

export async function runBlobPrimitivesProbe(): Promise<ProbeReport> {
  const dir = new Directory(Paths.document, PROBE_DIR);
  const platform = `${Platform.OS} ${String(Platform.Version)}`;

  try {
    if (dir.exists) dir.delete();
    dir.create({ intermediates: true });

    const checks = [
      ...(await probeWriteAtOffset(dir.uri.replace('file://', ''))),
      ...probePakoStreaming(),
    ];

    return {
      platform,
      checks,
      allPassed: checks.every((c) => c.pass),
    };
  } catch (err) {
    // A thrown probe is a FAILED probe, never an inconclusive one.
    return {
      platform,
      checks: [],
      allPassed: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  } finally {
    try {
      if (dir.exists) dir.delete();
    } catch {
      // Cleanup failure must not mask the result above.
    }
  }
}

/** The report as pasteable text. */
export function formatProbeReport(r: ProbeReport): string {
  const lines = [
    `backup blob primitives probe — ${r.platform}`,
    `result: ${r.allPassed ? 'ALL PASSED' : 'FAILED'}`,
    '',
  ];
  if (r.error) lines.push(`threw: ${r.error}`, '');
  for (const c of r.checks) {
    lines.push(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`, `      ${c.detail}`);
  }
  return lines.join('\n');
}
