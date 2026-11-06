/**
 * Verification tests for the TDX attestation verifier.
 *
 * The fixture is a REAL response captured live from NEAR AI (2026-08-08) — all
 * of it is public attestation data, no secrets. Testing against synthetic
 * quotes would be worthless here: the whole risk in this module is getting a
 * wire detail wrong (hex vs base64, high-s signatures, offsets), and only real
 * bytes catch that.
 *
 * The two TAMPER tests at the bottom are the point of the file. A verifier that
 * returns `pass` on everything is indistinguishable from one that returns
 * `pass` unconditionally unless something is proven to make it fail.
 */
import { generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { p384 } from '@noble/curves/nist.js';
import { sha256, sha384 } from '@noble/hashes/sha2.js';
import fixture from '@/test/fixtures/attestation-report.json';
import gpu1a from '@/test/fixtures/attestation/1gpu-004-0.json';
import gpu1b from '@/test/fixtures/attestation/1gpu-004-1.json';
import gpu8a from '@/test/fixtures/attestation/8gpu-004-2.json';
import gpu8b from '@/test/fixtures/attestation/8gpu-004-3.json';
import gpu8c from '@/test/fixtures/attestation/8gpu-004-4.json';
import int005 from '@/test/fixtures/attestation/intermediate-005-jwk.json';
import {
  NVIDIA_NRAS_ROOT_CA_DER_B64,
  NVIDIA_NRAS_ROOT_CA_DER_SHA256,
  verifyNvidiaAttestation,
  bytesToHex,
  derSignatureToRaw,
  hexToBytes,
  parseCertificate,
  parseQuote,
  pemToDerList,
  summarize,
  verifyAttestation,
  INTEL_SGX_ROOT_CA_DER_SHA256,
  type CheckId,
  type CheckResult,
} from '@/lib/algorithms/attestation-verify';

const att = fixture.model_attestations[0];

/**
 * The nonce the CLIENT sent when this fixture was captured — hardcoded here
 * DELIBERATELY, not read from the fixture.
 *
 * Taking it from `att.request_nonce` would make the freshness assertion
 * circular: it would compare the response against itself and pass even if the
 * check were `reportData[32:64] === reportData[32:64]`. Freshness is the one
 * check whose failure mode is silent, so the expected value has to come from
 * outside the response body — exactly as it does in production, where the
 * client generates the nonce before the request.
 *
 * If the fixture is ever recaptured, pass this exact nonce as the `nonce` query
 * param and this constant stays correct.
 */
const CLIENT_NONCE = '5ec0ffee'.repeat(8);

/** Inside the fixture's certificate validity windows (all valid to 2033+). */
const NOW = new Date('2026-08-08T00:00:00Z');

function baseInput() {
  return {
    quoteHex: att.intel_quote,
    signingPublicKey: att.signing_public_key,
    signingAlgo: att.signing_algo,
    expectedNonce: CLIENT_NONCE,
    hasGpuPayload: true,
    now: NOW,
  };
}

function statusOf(checks: CheckResult[], id: CheckId): string {
  const c = checks.find(x => x.id === id);
  if (!c) throw new Error(`no check "${id}"`);
  return c.status;
}

describe('quote parsing', () => {
  it('parses the live TDX v4 quote', () => {
    const q = parseQuote(att.intel_quote);
    expect(q.version).toBe(4);
    expect(q.attKeyType).toBe(2); // ECDSA P-256 — fixes curve as p256/sha256
    expect(q.teeType).toBe(0x81); // TDX
    expect(q.signedBody).toHaveLength(48 + 584);
    expect(q.reportData).toHaveLength(64);
    expect(q.attestationKey).toHaveLength(64);
    expect(q.qeReport).toHaveLength(384);
  });

  it('extracts the full PCK chain embedded in the quote', () => {
    const q = parseQuote(att.intel_quote);
    // leaf → PCK Platform CA → SGX Root CA. The chain travels inside the
    // quote, which is exactly why the root must be pinned.
    expect(q.certChain).toHaveLength(3);
  });

  it('confirms report_data is signing_public_key ‖ request_nonce', () => {
    const q = parseQuote(att.intel_quote);
    // Bound against the hardcoded CLIENT nonce, not the echoed field.
    expect(bytesToHex(q.reportData)).toBe(att.signing_public_key + CLIENT_NONCE);
  });

  it('rejects a truncated quote', () => {
    expect(() => parseQuote('0400')).toThrow(/too short/i);
  });

  it('rejects non-hex input', () => {
    expect(() => parseQuote('zzzz')).toThrow(/hex/i);
  });

  it('rejects an odd-length hex string', () => {
    expect(() => hexToBytes('abc')).toThrow(/odd length/i);
  });
});

describe('DER / X.509 parsing', () => {
  const chain = parseQuote(att.intel_quote).certChain;

  it('parses every certificate in the chain', () => {
    for (const der of chain) {
      const c = parseCertificate(der);
      expect(c.publicKey).toHaveLength(65);
      expect(c.publicKey[0]).toBe(0x04);
      expect(c.signature).toHaveLength(64);
      expect(c.notAfter.getTime()).toBeGreaterThan(c.notBefore.getTime());
    }
  });

  it('exposes the exact tbsCertificate bytes the signature covers', () => {
    const c = parseCertificate(chain[0]);
    // tbs must be a DER SEQUENCE and strictly shorter than the whole cert.
    expect(c.tbs[0]).toBe(0x30);
    expect(c.tbs.length).toBeLessThan(c.der.length);
  });

  it('rejects a non-SEQUENCE root', () => {
    expect(() => parseCertificate(new Uint8Array([0x02, 0x01, 0x00]))).toThrow(/SEQUENCE/);
  });

  it('rejects a truncated certificate', () => {
    expect(() => parseCertificate(chain[0].subarray(0, 20))).toThrow(/DER/);
  });

  it('rejects the DER indefinite-length form', () => {
    // 0x80 length byte is legal BER but forbidden in DER.
    expect(() => parseCertificate(new Uint8Array([0x30, 0x80, 0x00, 0x00]))).toThrow(
      /bad length form/,
    );
  });

  it('normalises DER signature INTEGERs to raw 32‖32', () => {
    // r has a leading zero pad (33 bytes), s is short (31 bytes).
    const r = new Uint8Array(33);
    r[0] = 0x00;
    r[1] = 0xff;
    const s = new Uint8Array(31).fill(0x11);
    const der = new Uint8Array([0x30, 2 + r.length + 2 + s.length, 0x02, r.length, ...r, 0x02, s.length, ...s]);
    const raw = derSignatureToRaw(der);
    expect(raw).toHaveLength(64);
    expect(raw[0]).toBe(0xff); // pad stripped, left-aligned
    expect(raw[32]).toBe(0x00); // short value right-aligned into its half
    expect(raw[33]).toBe(0x11);
  });

  it('rejects a signature whose r/s are not INTEGERs', () => {
    expect(() => derSignatureToRaw(new Uint8Array([0x30, 0x03, 0x04, 0x01, 0x00]))).toThrow(
      /INTEGER/,
    );
  });

  it('returns an empty list for a PEM with no certificates', () => {
    expect(pemToDerList('nothing here')).toHaveLength(0);
  });
});

describe('verifyAttestation — the genuine live report', () => {
  const report = verifyAttestation(baseInput());

  it.each([
    ['quote-structure'],
    ['report-data-key'],
    ['freshness-nonce'],
    ['signing-algo'],
    ['qe-report-signature'],
    ['attestation-key-binding'],
    ['quote-signature'],
    ['pck-chain'],
    ['root-ca-pin'],
  ] as [CheckId][])('passes %s', id => {
    expect(statusOf(report.checks, id)).toBe('pass');
  });

  it('reports TCB status and GPU attestation as NOT CHECKED, never pass', () => {
    // These are the honest gaps. If either ever reads `pass` without the
    // corresponding collateral fetch being implemented, the UI is lying.
    expect(statusOf(report.checks, 'tcb-status')).toBe('not-checked');
    expect(statusOf(report.checks, 'gpu-attestation')).toBe('not-checked');
  });

  it('summarises as INCOMPLETE, not verified, while anything is unchecked', () => {
    expect(report.verdict).toBe('incomplete');
  });

  it('anchors to the pinned Intel SGX Root CA', () => {
    expect(INTEL_SGX_ROOT_CA_DER_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyAttestation — freshness', () => {
  it('marks freshness NOT CHECKED when no nonce was sent', () => {
    // A cached/nonce-free fetch must never render freshness as a green tick:
    // the report is cached 30 min client-side, 10 min gateway-side and
    // (measured) upstream as well, so it could be arbitrarily old.
    const r = verifyAttestation({ ...baseInput(), expectedNonce: undefined });
    expect(statusOf(r.checks, 'freshness-nonce')).toBe('not-checked');
  });

  it('FAILS when the quote commits a different nonce (replayed report)', () => {
    const r = verifyAttestation({ ...baseInput(), expectedNonce: 'ab'.repeat(32) });
    expect(statusOf(r.checks, 'freshness-nonce')).toBe('fail');
    expect(r.verdict).toBe('failed');
  });

  it('FAILS on a malformed nonce rather than passing it', () => {
    const r = verifyAttestation({ ...baseInput(), expectedNonce: 'not-hex' });
    expect(statusOf(r.checks, 'freshness-nonce')).toBe('fail');
  });
});

describe('verifyAttestation — signing_algo cross-check', () => {
  it('fails when the attested algo disagrees with the key length', () => {
    // The rest of the app infers the algo from byte length alone; this is the
    // check that notices the server claiming something else.
    const r = verifyAttestation({ ...baseInput(), signingAlgo: 'ecdsa' });
    expect(statusOf(r.checks, 'signing-algo')).toBe('fail');
  });

  it('is not-checked when no algo is reported', () => {
    const r = verifyAttestation({ ...baseInput(), signingAlgo: undefined });
    expect(statusOf(r.checks, 'signing-algo')).toBe('not-checked');
  });

  it('fails when the served key is not valid hex', () => {
    const r = verifyAttestation({ ...baseInput(), signingPublicKey: 'nope' });
    expect(statusOf(r.checks, 'signing-algo')).toBe('fail');
  });
});

describe('verifyAttestation — malformed quote', () => {
  const r = verifyAttestation({ ...baseInput(), quoteHex: '0400' });

  it('fails the structure check without throwing', () => {
    expect(statusOf(r.checks, 'quote-structure')).toBe('fail');
  });

  it('marks the dependent checks not-checked rather than inventing failures', () => {
    expect(statusOf(r.checks, 'quote-signature')).toBe('not-checked');
    expect(statusOf(r.checks, 'pck-chain')).toBe('not-checked');
  });
});

describe('summarize', () => {
  it('is failed if anything failed, even alongside passes', () => {
    expect(
      summarize([
        { id: 'quote-structure', status: 'pass', detail: '' },
        { id: 'report-data-key', status: 'fail', detail: '' },
      ]).verdict,
    ).toBe('failed');
  });

  it('is verified only when every check passed', () => {
    expect(summarize([{ id: 'quote-structure', status: 'pass', detail: '' }]).verdict).toBe(
      'verified',
    );
  });

  it('is incomplete when something is unchecked', () => {
    expect(
      summarize([{ id: 'tcb-status', status: 'not-checked', detail: '' }]).verdict,
    ).toBe('incomplete');
  });
});

describe('malformed structures are rejected, not tolerated', () => {
  // A lenient parser is an attack surface: every one of these would otherwise
  // be a way to slip a bad quote or certificate past the checks.
  const q = parseQuote(att.intel_quote);

  it('rejects a quote whose signature section overruns the buffer', () => {
    const bytes = hexToBytes(att.intel_quote);
    const tampered = new Uint8Array(bytes);
    const off = 48 + 584;
    tampered[off] = 0xff;
    tampered[off + 1] = 0xff;
    tampered[off + 2] = 0xff;
    tampered[off + 3] = 0x7f;
    expect(() => parseQuote(bytesToHex(tampered))).toThrow(/overruns/);
  });

  it('rejects an unsupported qe_cert_data type', () => {
    const tampered = new Uint8Array(hexToBytes(att.intel_quote));
    tampered[48 + 584 + 4 + 64 + 64] = 3; // not 6
    expect(() => parseQuote(bytesToHex(tampered))).toThrow(/qe_cert_data type 3/);
  });

  it('rejects an unsupported inner certificate type', () => {
    const bytes = new Uint8Array(hexToBytes(att.intel_quote));
    let o = 48 + 584 + 4 + 64 + 64 + 6 + 384 + 64;
    const authLen = bytes[o] | (bytes[o + 1] << 8);
    o += 2 + authLen;
    bytes[o] = 9; // not 5
    expect(() => parseQuote(bytesToHex(bytes))).toThrow(/inner cert type 9/);
  });

  // Hand-built minimal DER rather than poking at real bytes: each of these
  // targets one specific structural guard deterministically.
  it('rejects a certificate whose validity is not a SEQUENCE', () => {
    // Certificate ::= SEQ { tbs SEQ { serial, sigAlg, issuer, validity… }, … }
    // Here `validity` is a NULL, not a SEQUENCE.
    const tbs = seq([int(1), seq([]), seq([]), nul()]);
    const cert = seq([tbs, seq([]), bitString(dummySig())]);
    expect(() => parseCertificate(cert)).toThrow(/validity is not a SEQUENCE/);
  });

  it('rejects a certificate whose subjectPublicKeyInfo is not a SEQUENCE', () => {
    const validity = seq([utcTime('300101000000Z'), utcTime('400101000000Z')]);
    const tbs = seq([int(1), seq([]), seq([]), validity, seq([]), nul()]);
    const cert = seq([tbs, seq([]), bitString(dummySig())]);
    expect(() => parseCertificate(cert)).toThrow(/subjectPublicKeyInfo/);
  });

  it('rejects a certificate whose public key is not an uncompressed EC point', () => {
    const validity = seq([utcTime('300101000000Z'), utcTime('400101000000Z')]);
    // SPKI with a 3-byte "key" instead of a 65-byte 0x04-prefixed point.
    const spki = seq([seq([]), bitString([0x01, 0x02, 0x03])]);
    const tbs = seq([int(1), seq([]), seq([]), validity, seq([]), spki]);
    const cert = seq([tbs, seq([]), bitString(dummySig())]);
    expect(() => parseCertificate(cert)).toThrow(/uncompressed EC point/);
  });

  it('rejects a certificate whose signatureValue is not a BIT STRING', () => {
    const cert = seq([seq([]), seq([]), nul()]);
    expect(() => parseCertificate(cert)).toThrow(/signatureValue is not a BIT STRING/);
  });

  it('rejects a certificate with fewer than three elements', () => {
    expect(() => parseCertificate(seq([seq([])]))).toThrow(/3 elements/);
  });

  it('fails the chain when it carries too few certificates', () => {
    const bytes = rebuildQuoteWithChain(att.intel_quote, [q.certChain[0]]);
    const r = verifyAttestation({ ...baseInput(), quoteHex: bytes });
    expect(statusOf(r.checks, 'pck-chain')).toBe('fail');
    expect(statusOf(r.checks, 'root-ca-pin')).toBe('not-checked');
  });

  it('treats a bad EC point as a verification failure, not a crash', () => {
    // Corrupt the attestation key so the point is off-curve. verifyP256 must
    // swallow the noble throw and report `fail` — a crash here would take the
    // whole settings screen down.
    const bytes = new Uint8Array(hexToBytes(att.intel_quote));
    const keyOff = 48 + 584 + 4 + 64;
    for (let i = 0; i < 64; i++) bytes[keyOff + i] = 0xff;
    const r = verifyAttestation({ ...baseInput(), quoteHex: bytesToHex(bytes) });
    expect(statusOf(r.checks, 'quote-signature')).toBe('fail');
  });

  it('fails the QE report signature when the QE report is altered', () => {
    const bytes = new Uint8Array(hexToBytes(att.intel_quote));
    const qeOff = 48 + 584 + 4 + 64 + 64 + 6;
    bytes[qeOff] ^= 0xff; // a byte OUTSIDE the report_data region
    const r = verifyAttestation({ ...baseInput(), quoteHex: bytesToHex(bytes) });
    expect(statusOf(r.checks, 'qe-report-signature')).toBe('fail');
    // The key binding lives at report_data (offset 320) and is untouched here,
    // so it still passes. The two checks are independent on purpose — each
    // covers a different substitution, and neither implies the other.
    expect(statusOf(r.checks, 'attestation-key-binding')).toBe('pass');
  });

  it('fails the attestation-key binding when the QE report_data is altered', () => {
    const bytes = new Uint8Array(hexToBytes(att.intel_quote));
    const qeReportDataOff = 48 + 584 + 4 + 64 + 64 + 6 + 320;
    bytes[qeReportDataOff] ^= 0xff;
    const r = verifyAttestation({ ...baseInput(), quoteHex: bytesToHex(bytes) });
    expect(statusOf(r.checks, 'attestation-key-binding')).toBe('fail');
  });

  it('fails the chain when a certificate is outside its validity window', () => {
    // All fixture certs expire by 2033; pretend it is 2040.
    const r = verifyAttestation({ ...baseInput(), now: new Date('2040-01-01T00:00:00Z') });
    expect(statusOf(r.checks, 'pck-chain')).toBe('fail');
  });

  it('fails an unsupported signing-key length', () => {
    const r = verifyAttestation({
      ...baseInput(),
      signingPublicKey: 'ab'.repeat(16), // 16 bytes: neither 32 nor 64
      signingAlgo: 'ed25519',
    });
    expect(statusOf(r.checks, 'signing-algo')).toBe('fail');
  });
});

// ── Tiny DER builders, for constructing precisely-malformed certificates ─────
// Only short-form lengths (<128 bytes) are needed here.

function tlv(tag: number, content: number[] | Uint8Array): Uint8Array {
  const body = Array.from(content);
  if (body.length > 127) throw new Error('test DER builder: short form only');
  return new Uint8Array([tag, body.length, ...body]);
}
function seq(children: (Uint8Array | number[])[]): Uint8Array {
  const body: number[] = [];
  for (const c of children) body.push(...Array.from(c));
  return tlv(0x30, body);
}
function int(v: number): Uint8Array {
  return tlv(0x02, [v]);
}
function nul(): Uint8Array {
  return tlv(0x05, []);
}
function bitString(bytes: number[]): Uint8Array {
  return tlv(0x03, [0x00, ...bytes]); // leading "unused bits" octet
}
/** A structurally valid ECDSA-Sig-Value, so parseCertificate gets past the
 *  signature parse and reaches the tbsCertificate walk under test. */
function dummySig(): number[] {
  return Array.from(seq([int(1), int(1)]));
}
function utcTime(s: string): Uint8Array {
  return tlv(0x17, Array.from(new TextEncoder().encode(s)));
}

// ─── TAMPER TESTS ────────────────────────────────────────────────────────────
// These are the tests that make the rest meaningful.

describe('TAMPER: substituted signing key with a genuine quote', () => {
  // The exact attack the report_data binding exists to stop: a gateway serves
  // a REAL, fully-valid NEAR quote alongside a public key it holds the secret
  // for. Every signature still verifies — the quote is genuine — so chain
  // verification alone passes and the operator decrypts every prompt.
  const attackerKey = 'de'.repeat(32);
  const report = verifyAttestation({ ...baseInput(), signingPublicKey: attackerKey });

  it('FAILS the report_data binding', () => {
    expect(statusOf(report.checks, 'report-data-key')).toBe('fail');
  });

  it('drives the overall verdict to failed', () => {
    expect(report.verdict).toBe('failed');
  });

  it.each([
    ['quote-structure'],
    ['qe-report-signature'],
    ['attestation-key-binding'],
    ['quote-signature'],
    ['pck-chain'],
    ['root-ca-pin'],
  ] as [CheckId][])(
    'still passes %s — proving the binding check is what caught it',
    id => {
      // If tampering the key ALSO broke these, this test would not be
      // isolating the binding — it would be catching the attack by accident
      // and would not prove the binding check does anything.
      expect(statusOf(report.checks, id)).toBe('pass');
    },
  );
});

describe('TAMPER: forged self-signed root CA', () => {
  // The PCK chain travels inside the quote, so an attacker can swap the whole
  // chain. The compiled-in root pin is the only thing that makes chain
  // verification non-circular. Dropping the real root and re-anchoring on the
  // intermediate produces an internally-consistent chain that must still fail.
  const q = parseQuote(att.intel_quote);
  const forged = [q.certChain[0], q.certChain[1]]; // real root removed

  it('FAILS the root CA pin', () => {
    const r = verifyChainOnly(forged);
    expect(statusOf(r, 'root-ca-pin')).toBe('fail');
  });

  it('fails even though the remaining links are internally consistent', () => {
    const r = verifyChainOnly(forged);
    // The leaf genuinely is signed by the intermediate, so pck-chain can pass
    // on its own — which is exactly why the pin, not the chain, is the anchor.
    expect(statusOf(r, 'root-ca-pin')).toBe('fail');
  });
});

/** Drive verifyAttestation with a substituted chain by re-encoding the quote. */
function verifyChainOnly(chain: Uint8Array[]): CheckResult[] {
  const quoteHex = rebuildQuoteWithChain(att.intel_quote, chain);
  return verifyAttestation({ ...baseInput(), quoteHex }).checks;
}

/**
 * Re-emit the quote with a different PCK chain, keeping every other byte.
 * Only used to build the forged-root fixture above.
 */
function rebuildQuoteWithChain(quoteHex: string, chain: Uint8Array[]): string {
  const q = hexToBytes(quoteHex);
  const pem = chain.map(derToPem).join('');
  const pemBytes = new TextEncoder().encode(pem);

  // Walk to the inner cert-data header exactly as parseQuote does.
  let o = 48 + 584 + 4 + 64 + 64;
  o += 6; // qe_cert_data header
  o += 384 + 64; // qe report + signature
  const authLen = q[o] | (q[o + 1] << 8);
  o += 2 + authLen;
  const innerHeader = o;
  const prefix = q.subarray(0, innerHeader);

  const out = new Uint8Array(prefix.length + 6 + pemBytes.length);
  out.set(prefix, 0);
  out[prefix.length] = 5; // inner type: PCK chain
  out[prefix.length + 1] = 0;
  const size = pemBytes.length;
  out[prefix.length + 2] = size & 0xff;
  out[prefix.length + 3] = (size >> 8) & 0xff;
  out[prefix.length + 4] = (size >> 16) & 0xff;
  out[prefix.length + 5] = (size >> 24) & 0xff;
  out.set(pemBytes, prefix.length + 6);

  // Rewrite sig_data_len — it counts the bytes AFTER the length field, and
  // shortening the chain shortens the section. Leaving the original value
  // makes parseQuote reject the quote outright (overrun), which would make
  // this test pass for the wrong reason.
  const sigDataStart = 48 + 584 + 4;
  const newSigLen = out.length - sigDataStart;
  out[sigDataStart - 4] = newSigLen & 0xff;
  out[sigDataStart - 3] = (newSigLen >> 8) & 0xff;
  out[sigDataStart - 2] = (newSigLen >> 16) & 0xff;
  out[sigDataStart - 1] = (newSigLen >> 24) & 0xff;
  return bytesToHex(out);
}

function derToPem(der: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < der.length; i++) bin += String.fromCharCode(der[i]);
  const b64 = toBase64(bin);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

function toBase64(bin: string): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bin.length; i += 3) {
    const a = bin.charCodeAt(i);
    const b = i + 1 < bin.length ? bin.charCodeAt(i + 1) : NaN;
    const c = i + 2 < bin.length ? bin.charCodeAt(i + 2) : NaN;
    out += A[a >> 2];
    out += A[((a & 3) << 4) | (isNaN(b) ? 0 : b >> 4)];
    out += isNaN(b) ? '=' : A[((b & 15) << 2) | (isNaN(c) ? 0 : c >> 6)];
    out += isNaN(c) ? '=' : A[c & 63];
  }
  return out;
}


// ─── NVIDIA GPU attestation: the tamper matrix ───────────────────────────────

const GPU_NOW = new Date('2026-11-06T02:30:00Z');
const GPU_NOW_S = GPU_NOW.getTime() / 1000;
/** Hardcoded like CLIENT_NONCE: the fixtures' own `nonce` is never read. */
const NONCE_1GPU = 'ebbaa3eafb3f3765cccf6fd57750991f77ba33499838045bc31c4c3f58821a91';
const NONCE_8GPU = '38f1695ee946485002b83ce685ee5be8cc70fb144314d7927dd8887233f14c7f';
const WRONG_NONCE = 'ab'.repeat(32);

type Raw = { tokens: [[string, string], Record<string, string>]; keys: { kid: string; x5c: string[] }[] };
type Fx = { reply: unknown; jwk: unknown };
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const wire = (fx: Fx): Raw => clone({ tokens: fx.reply, keys: [fx.jwk] }) as Raw;
const b64u = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');
const claimsOf = (t: string): Record<string, number> =>
  JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
const flipSignatureByte = (t: string) => {
  const [h, p, s] = t.split('.');
  const sig = Buffer.from(s, 'base64url');
  sig[10] ^= 0x01;
  return `${h}.${p}.${b64u(sig)}`;
};
const flipLastByte = (b64: string) => {
  const der = Buffer.from(b64, 'base64');
  der[der.length - 1] ^= 0x01;
  return der.toString('base64');
};

/** Every call asserts that no detail carries the nonce or a 24+ char fragment of
 *  anything in the input (tokens, digests, kids). */
function verify(raw: unknown, nonce: string | undefined, now: Date, rootDer?: Uint8Array) {
  const r = verifyNvidiaAttestation(raw, nonce, now, rootDer);
  if (nonce) expect(r.detail).not.toContain(nonce);
  for (const frag of (JSON.stringify(raw) ?? '').match(/[A-Za-z0-9_-]{24,}/g) ?? []) {
    expect(r.detail).not.toContain(frag);
  }
  return r;
}

const NOT_READ = 'the NVIDIA attestation has a shape this build does not read';
const fail = (detail: string) => ({ status: 'fail', detail });
const notChecked = (detail: string) => ({ status: 'not-checked', detail });

describe('verifyNvidiaAttestation: real NRAS tokens, pinned root', () => {
  const real: [string, Fx, string, number][] = [
    ['1 GPU (kid A)', gpu1a, NONCE_1GPU, 1],
    ['1 GPU (kid B)', gpu1b, NONCE_1GPU, 1],
    ['8 GPUs (kid A, run 2)', gpu8a, NONCE_8GPU, 8],
    ['8 GPUs (kid A, run 3)', gpu8b, NONCE_8GPU, 8],
    ['8 GPUs (kid C)', gpu8c, NONCE_8GPU, 8],
  ];

  it('shares kids as the fixtures were captured', () => {
    const kid = (f: Fx) => (f.jwk as { kid: string }).kid;
    expect(kid(gpu1a)).toBe(kid(gpu8a));
    expect(kid(gpu8a)).toBe(kid(gpu8b));
    expect(kid(gpu8c)).not.toBe(kid(gpu8a));
    expect(kid(gpu1b)).not.toBe(kid(gpu1a));
    expect(kid(gpu1b)).not.toBe(kid(gpu8c));
  });

  it.each(real)('passes on %s', (_n, fx, nonce, count) => {
    expect(verify(wire(fx), nonce, GPU_NOW)).toEqual({
      status: 'pass',
      detail: `NVIDIA signed a passing result for ${count} GPU(s)`,
    });
  });

  it('fails on the wrong nonce', () => {
    expect(verify(wire(gpu1a), WRONG_NONCE, GPU_NOW)).toEqual(fail('eat_nonce is not the required value'));
  });

  it('fails on a flipped signature byte of the overall token', () => {
    const raw = wire(gpu8a);
    raw.tokens[0][1] = flipSignatureByte(raw.tokens[0][1]);
    expect(verify(raw, NONCE_8GPU, GPU_NOW)).toEqual(fail('a token signature did not verify'));
  });

  it('fails on a flipped signature byte of a GPU token', () => {
    const raw = wire(gpu8a);
    raw.tokens[1]['GPU-4'] = flipSignatureByte(raw.tokens[1]['GPU-4']);
    expect(verify(raw, NONCE_8GPU, GPU_NOW)).toEqual(fail('a token signature did not verify'));
  });

  it('fails when a validly signed GPU-0 from another run is swapped in (digest)', () => {
    const raw = wire(gpu8a);
    raw.tokens[1]['GPU-0'] = wire(gpu8b).tokens[1]['GPU-0'];
    expect(verify(raw, NONCE_8GPU, GPU_NOW)).toEqual(fail('GPU-0 does not match the overall token'));
  });

  it('fails when a listed GPU has no token', () => {
    const raw = wire(gpu8a);
    delete raw.tokens[1]['GPU-3'];
    expect(verify(raw, NONCE_8GPU, GPU_NOW)).toEqual(fail('GPU-3 has no token'));
  });

  it('fails on an extra token the overall token does not list', () => {
    const raw = wire(gpu8a);
    raw.tokens[1]['GPU-9'] = raw.tokens[1]['GPU-0'];
    expect(verify(raw, NONCE_8GPU, GPU_NOW)).toEqual(fail('GPU-9 is not in the overall token'));
  });

  it('fails on a swapped leaf: a real chain, another leaf key', () => {
    const raw = wire(gpu8a);
    raw.keys[0].x5c[0] = wire(gpu8c).keys[0].x5c[0];
    expect(verify(raw, NONCE_8GPU, GPU_NOW)).toEqual(fail('a token signature did not verify'));
  });

  it('fails under the real 005 chain: the EC link passed, so the key is simply not the signer', () => {
    const raw = wire(gpu8a);
    raw.keys[0].x5c = clone((int005 as { x5c: string[] }).x5c);
    expect(Buffer.from(raw.keys[0].x5c[1], 'base64')).toHaveLength(742);
    expect(verify(raw, NONCE_8GPU, GPU_NOW)).toEqual(fail('a token signature did not verify'));
  });

  it('is not-checked without a client nonce', () => {
    expect(verify(wire(gpu1a), undefined, GPU_NOW)).toEqual(notChecked('no client nonce to compare'));
    expect(verify(wire(gpu1a), '', GPU_NOW)).toEqual(notChecked('no client nonce to compare'));
  });

  it('is not-checked a day later: the leaf has expired', () => {
    const later = new Date(GPU_NOW.getTime() + 86_400_000);
    expect(verify(wire(gpu1a), NONCE_1GPU, later)).toEqual(
      notChecked('a certificate is outside its validity window'),
    );
  });

  describe('token window, 60 s leeway', () => {
    const raw = wire(gpu8a);
    const all = [raw.tokens[0][1], ...Object.values(raw.tokens[1])].map(claimsOf);
    const minExp = Math.min(...all.map(c => c.exp));
    const maxNbf = Math.max(...all.map(c => c.nbf));
    const at = (s: number) => new Date(s * 1000);

    it('accepts exp + 59 s and nbf - 59 s', () => {
      expect(verify(wire(gpu8a), NONCE_8GPU, at(minExp + 59)).status).toBe('pass');
      expect(verify(wire(gpu8a), NONCE_8GPU, at(maxNbf - 59)).status).toBe('pass');
    });
    it('rejects exp + 61 s and nbf - 61 s as the phone clock', () => {
      const w = notChecked('a token is outside its time window');
      expect(verify(wire(gpu8a), NONCE_8GPU, at(minExp + 61))).toEqual(w);
      expect(verify(wire(gpu8a), NONCE_8GPU, at(maxNbf - 61))).toEqual(w);
    });
  });

  it('is not-checked for 1 or 3 certificates', () => {
    const one = wire(gpu1a);
    one.keys[0].x5c = [one.keys[0].x5c[0]];
    const three = wire(gpu1a);
    three.keys[0].x5c = [...three.keys[0].x5c, three.keys[0].x5c[1]];
    const w = notChecked('expected a leaf and an intermediate certificate');
    expect(verify(one, NONCE_1GPU, GPU_NOW)).toEqual(w);
    expect(verify(three, NONCE_1GPU, GPU_NOW)).toEqual(w);
  });

  it('is not-checked when a 004 leaf sits under the 005 intermediate', () => {
    const raw = wire(gpu1a);
    raw.keys[0].x5c[1] = (int005 as { x5c: string[] }).x5c[1];
    expect(verify(raw, NONCE_1GPU, GPU_NOW).status).toBe('not-checked');
  });

  it('is not-checked for a flipped byte in the real leaf RSA signature', () => {
    const raw = wire(gpu1a);
    raw.keys[0].x5c[0] = flipLastByte(raw.keys[0].x5c[0]);
    expect(verify(raw, NONCE_1GPU, GPU_NOW)).toEqual(
      notChecked('the leaf does not chain to its intermediate'),
    );
  });

  it('is not-checked above the caps', () => {
    const keys = wire(gpu1a);
    keys.keys = Array.from({ length: 9 }, () => clone(keys.keys[0]));
    expect(verify(keys, NONCE_1GPU, GPU_NOW)).toEqual(notChecked('more keys than this build reads'));

    const toks = wire(gpu1a);
    for (let i = 1; i <= 16; i++) toks.tokens[1][`GPU-${i}`] = toks.tokens[1]['GPU-0'];
    expect(verify(toks, NONCE_1GPU, GPU_NOW)).toEqual(notChecked('more GPU tokens than this build reads'));
  });

  it('is not-checked for a duplicate kid and for a kid with no key', () => {
    const dup = wire(gpu1a);
    dup.keys.push(clone(dup.keys[0]));
    expect(verify(dup, NONCE_1GPU, GPU_NOW)).toEqual(notChecked('a key id appears twice'));

    const orphan = wire(gpu1a);
    orphan.keys[0].kid = 'some-other-kid';
    expect(verify(orphan, NONCE_1GPU, GPU_NOW)).toEqual(notChecked('a token has no matching key'));
  });

  it('is not-checked for an NVSwitch token', () => {
    const raw = wire(gpu1a);
    raw.tokens[1]['SWITCH-0'] = raw.tokens[1]['GPU-0'];
    delete raw.tokens[1]['GPU-0'];
    expect(verify(raw, NONCE_1GPU, GPU_NOW)).toEqual(notChecked('a token is not for a GPU'));
  });

  it('reads a __proto__ token name as a name, not as a prototype', () => {
    const good = wire(gpu1a);
    const raw = { ...good, tokens: [good.tokens[0], JSON.parse(`{"__proto__": "${good.tokens[1]['GPU-0']}"}`)] };
    expect(Object.keys(raw.tokens[1])).toEqual(['__proto__']);
    expect(verify(raw, NONCE_1GPU, GPU_NOW)).toEqual(notChecked('a token is not for a GPU'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('is not-checked when alg is changed to none', () => {
    const raw = wire(gpu1a);
    const [, p, s] = raw.tokens[0][1].split('.');
    raw.tokens[0][1] = `${b64u(JSON.stringify({ alg: 'none', kid: raw.keys[0].kid }))}.${p}.${s}`;
    expect(verify(raw, NONCE_1GPU, GPU_NOW)).toEqual(notChecked('unexpected token algorithm'));
  });

  it.each([[{}], ['a string'], [42], [null], [undefined], [{ tokens: [], keys: [] }]])(
    'is not-checked for the garbage shape %j',
    garbage => {
      expect(verify(garbage, NONCE_1GPU, GPU_NOW)).toEqual(notChecked(NOT_READ));
    },
  );
});

describe('verifyAttestation: the GPU row', () => {
  const base = { quoteHex: att.intel_quote, signingPublicKey: att.signing_public_key, now: GPU_NOW };
  const gpu = (r: ReturnType<typeof verifyAttestation>) => r.checks.find(c => c.id === 'gpu-attestation')!;

  it('words an absent token by whether a payload was served', () => {
    const withPayload = gpu(verifyAttestation({ ...base, hasGpuPayload: true }));
    const without = gpu(verifyAttestation({ ...base, hasGpuPayload: false }));
    expect(withPayload.status).toBe('not-checked');
    expect(without.status).toBe('not-checked');
    expect(withPayload.detail).not.toBe(without.detail);
  });

  it('still runs the GPU check beside a malformed quote', () => {
    const r = verifyAttestation({
      ...base,
      quoteHex: 'zz',
      expectedNonce: NONCE_1GPU,
      nvidiaAttestation: wire(gpu1a),
    });
    expect(r.checks.find(c => c.id === 'quote-structure')!.status).toBe('fail');
    expect(gpu(r)).toMatchObject({ status: 'pass' });
  });

  it('summarizes as incomplete with GPU pass and TCB not-checked', () => {
    const r = verifyAttestation({
      ...base,
      quoteHex: 'zz',
      expectedNonce: NONCE_1GPU,
      nvidiaAttestation: wire(gpu1a),
    });
    const kept = r.checks.filter(c => c.id === 'gpu-attestation' || c.id === 'tcb-status');
    expect(kept.map(c => c.status).sort()).toEqual(['not-checked', 'pass']);
    expect(summarize(kept).verdict).toBe('incomplete');
    expect(summarize([...kept, { id: 'gpu-attestation', status: 'fail', detail: '' }]).verdict).toBe('failed');
  });
});

describe('the pinned NVIDIA root', () => {
  it('hashes to its constant', () => {
    expect(bytesToHex(sha256(Buffer.from(NVIDIA_NRAS_ROOT_CA_DER_B64, 'base64')))).toBe(
      NVIDIA_NRAS_ROOT_CA_DER_SHA256,
    );
  });
});

// ─── Synthetic chain: every clause failing alone ─────────────────────────────

const cat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) (out.set(x, o), (o += x.length));
  return out;
};
/** Long-form lengths, which the file's own short-form helper does not cover. */
const tlvLong = (tag: number, ...parts: Uint8Array[]) => {
  const body = cat(...parts);
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return cat(Uint8Array.from([tag, ...len]), body);
};
const oid = (hex: string) => tlvLong(0x06, hexToBytes(hex));
const bitStringN = (b: Uint8Array) => tlvLong(0x03, Uint8Array.from([0]), b);
const derInt = (raw: Uint8Array) => {
  let i = 0;
  while (i < raw.length - 1 && raw[i] === 0) i++;
  const v = raw.subarray(i);
  return tlvLong(0x02, v[0] & 0x80 ? cat(Uint8Array.from([0]), v) : v);
};
const OID = {
  ecKey: '2a8648ce3d0201',
  p384: '2b81040022',
  rsaKey: '2a864886f70d010101',
  ecdsaSha384: '2a8648ce3d040303',
  rsaSha256: '2a864886f70d01010b',
  rsaSha1: '2a864886f70d010105',
};
const ecSpki = (pub: Uint8Array) =>
  tlvLong(0x30, tlvLong(0x30, oid(OID.ecKey), oid(OID.p384)), bitStringN(pub));
const rsaSpki = (n: Uint8Array, e = '010001') =>
  tlvLong(
    0x30,
    tlvLong(0x30, oid(OID.rsaKey), Uint8Array.from([5, 0])),
    bitStringN(tlvLong(0x30, derInt(n), derInt(hexToBytes(e)))),
  );
const utc = (s: string) => tlvLong(0x17, new TextEncoder().encode(s));
const ecSign = (sk: Uint8Array, msg: Uint8Array) => {
  const raw = p384.sign(sha384(msg), sk, { prehash: false, lowS: false });
  return tlvLong(0x30, derInt(raw.subarray(0, 48)), derInt(raw.subarray(48)));
};

function cert(spki: Uint8Array, sigOid: string, sign: (tbs: Uint8Array) => Uint8Array): Uint8Array {
  const tbs = tlvLong(
    0x30,
    tlvLong(0xa0, tlvLong(0x02, Uint8Array.from([2]))),
    tlvLong(0x02, Uint8Array.from([1])),
    tlvLong(0x30, oid(sigOid)),
    tlvLong(0x30),
    tlvLong(0x30, utc('261101000000Z'), utc('301231235959Z')),
    tlvLong(0x30),
    spki,
  );
  return tlvLong(0x30, tbs, tlvLong(0x30, oid(sigOid)), bitStringN(sign(tbs)));
}

const keypair = () => {
  const sk = p384.utils.randomSecretKey();
  return { sk, pub: p384.getPublicKey(sk, false) };
};
const rootKp = keypair();
const leafKp = keypair();
const KID = 'test-kid';
const rootDer = cert(ecSpki(rootKp.pub), OID.ecdsaSha384, tbs => ecSign(rootKp.sk, tbs));
const ecIntermediateKp = keypair();
const ecIntermediate = cert(ecSpki(ecIntermediateKp.pub), OID.ecdsaSha384, tbs => ecSign(rootKp.sk, tbs));
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

// An RSA intermediate, signed by the P-384 root, as NVIDIA's 004 is.
const rsaKp = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaN = Buffer.from(rsaKp.publicKey.export({ format: 'jwk' }).n as string, 'base64url');
const rsaIntermediate = (spki = rsaSpki(rsaN)) => cert(spki, OID.ecdsaSha384, tbs => ecSign(rootKp.sk, tbs));
const rsaLeaf = (sigOid = OID.rsaSha256) =>
  cert(ecSpki(leafKp.pub), sigOid, tbs => rsaSign('sha256', tbs, rsaKp.privateKey));

interface Spec {
  iss?: unknown;
  nonce?: string;
  overall?: Record<string, unknown>;
  gpu?: Record<string, unknown>;
  gpus?: number;
  digestAlg?: unknown;
  submods?: unknown;
  header?: Record<string, unknown>;
  x5c?: string[];
}

function jws(claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const h = b64u(JSON.stringify({ kid: KID, alg: 'ES384', ...header }));
  const p = b64u(JSON.stringify(claims));
  const sig = p384.sign(sha384(new TextEncoder().encode(`${h}.${p}`)), leafKp.sk, {
    prehash: false,
    lowS: false,
  });
  return `${h}.${p}.${b64u(sig)}`;
}

/** Digests are recomputed from the final GPU tokens, so only the edited clause fails. */
function build(spec: Spec = {}): Raw {
  const nonce = spec.nonce ?? NONCE_1GPU;
  const window = { nbf: GPU_NOW_S - 60, exp: GPU_NOW_S + 3540 };
  const gpuTokens: Record<string, string> = {};
  const submods: Record<string, unknown> = {};
  for (let i = 0; i < (spec.gpus ?? 2); i++) {
    const t = jws({
      eat_nonce: nonce,
      ...window,
      'x-nvidia-gpu-attestation-report-nonce-match': true,
      'x-nvidia-gpu-attestation-report-signature-verified': true,
      measres: 'success',
      secboot: true,
      dbgstat: 'disabled',
      ...spec.gpu,
    });
    gpuTokens[`GPU-${i}`] = t;
    submods[`GPU-${i}`] = [
      'DIGEST',
      [spec.digestAlg ?? 'SHA-256', bytesToHex(sha256(new TextEncoder().encode(t)))],
    ];
  }
  const overall = jws(
    {
      iss: spec.iss ?? 'https://nras.attestation.nvidia.com',
      eat_nonce: nonce,
      ...window,
      'x-nvidia-overall-att-result': true,
      submods: 'submods' in spec ? spec.submods : submods,
      ...spec.overall,
    },
    spec.header,
  );
  return {
    tokens: [['JWT', overall], gpuTokens],
    keys: [{ kid: KID, x5c: spec.x5c ?? [b64(ecLeaf()), b64(ecIntermediate)] }],
  };
}
const ecLeaf = () => cert(ecSpki(leafKp.pub), OID.ecdsaSha384, tbs => ecSign(ecIntermediateKp.sk, tbs));

describe('verifyNvidiaAttestation: synthetic P-384 chain', () => {
  const run = (spec?: Spec | Raw) =>
    verify('tokens' in (spec ?? {}) ? spec : build(spec as Spec), NONCE_1GPU, GPU_NOW, rootDer);

  it('control: the all-good token passes', () => {
    expect(run()).toEqual({ status: 'pass', detail: 'NVIDIA signed a passing result for 2 GPU(s)' });
  });

  it('with the default root the same complete chain is not-checked', () => {
    expect(verify(build(), NONCE_1GPU, GPU_NOW)).toEqual(
      notChecked('the intermediate does not chain to the pinned root'),
    );
  });

  it('fails on a wrong iss', () => {
    expect(run({ iss: 'https://evil.example' })).toEqual(fail('iss is not the required value'));
  });

  it.each([false, null])('fails when the overall result is %s beside a matching nonce', v => {
    expect(run({ overall: { 'x-nvidia-overall-att-result': v } })).toEqual(
      fail('x-nvidia-overall-att-result is not the required value'),
    );
  });

  it('fails on a wrong eat_nonce on the overall token and on a GPU token', () => {
    const w = fail('eat_nonce is not the required value');
    expect(run({ overall: { eat_nonce: WRONG_NONCE } })).toEqual(w);
    expect(run({ gpu: { eat_nonce: WRONG_NONCE } })).toEqual(w);
  });

  it.each([
    ['x-nvidia-gpu-attestation-report-nonce-match', false],
    ['x-nvidia-gpu-attestation-report-nonce-match', null],
    ['x-nvidia-gpu-attestation-report-signature-verified', false],
    ['x-nvidia-gpu-attestation-report-signature-verified', null],
    ['measres', 'failure'],
    ['measres', null],
    ['secboot', false],
    ['dbgstat', 'enabled'],
  ])('fails when GPU claim %s is %j', (name, value) => {
    expect(run({ gpu: { [name]: value } })).toEqual(fail(`${name} is not the required value`));
  });

  it('fails when a signed claim is missing', () => {
    expect(run({ gpu: { secboot: undefined } })).toEqual(fail('secboot is not the required value'));
  });

  it.each([
    ['overall', 'overall'],
    ['a GPU', 'gpu'],
  ] as const)('fails on a missing exp or a string nbf on %s', (_n, target) => {
    const w = fail('a token has no time window');
    expect(run({ [target]: { exp: undefined } })).toEqual(w);
    expect(run({ [target]: { nbf: String(GPU_NOW_S - 60) } })).toEqual(w);
  });

  it('is not-checked for a digest algorithm other than SHA-256', () => {
    expect(run({ digestAlg: 'SHA-384' })).toEqual(notChecked('unexpected digest algorithm'));
  });

  it('is not-checked for unreadable or empty submods', () => {
    expect(run({ submods: {} })).toEqual(notChecked('no GPU is listed'));
    expect(run({ submods: undefined })).toEqual(notChecked(NOT_READ));
    expect(run({ submods: 'GPU-0' })).toEqual(notChecked('a token is not for a GPU'));
  });

  it('is not-checked for an unknown token algorithm', () => {
    expect(run({ header: { alg: 'ES256' } })).toEqual(notChecked('unexpected token algorithm'));
  });

  it('is not-checked for a token type other than JWT', () => {
    const raw = build();
    raw.tokens[0][0] = 'JWE';
    expect(run(raw)).toEqual(notChecked('unexpected token type'));
  });

  it('is not-checked for a token outside its window', () => {
    expect(run({ gpu: { exp: GPU_NOW_S - 61 } })).toEqual(notChecked('a token is outside its time window'));
  });
});

describe('verifyNvidiaAttestation: RSA intermediate', () => {
  const run = (x5c: Uint8Array[]) => verify(build({ x5c: x5c.map(b64) }), NONCE_1GPU, GPU_NOW, rootDer);

  it('control: an RSA-signed leaf under an RSA intermediate passes', () => {
    expect(run([rsaLeaf(), rsaIntermediate()]).status).toBe('pass');
  });

  it('is not-checked for a modulus over 4096 bits (fake bytes)', () => {
    const fakeN = new Uint8Array(513).fill(0xff);
    expect(run([rsaLeaf(), rsaIntermediate(rsaSpki(fakeN))])).toEqual(
      notChecked('unsupported certificate key'),
    );
  });

  it('is not-checked for exponent 3', () => {
    expect(run([rsaLeaf(), rsaIntermediate(rsaSpki(rsaN, '03'))])).toEqual(
      notChecked('unsupported certificate key'),
    );
  });

  it('is not-checked for sha1WithRSA, and for an ecdsa OID under an RSA issuer', () => {
    const w = notChecked('unsupported certificate signature algorithm');
    expect(run([rsaLeaf(OID.rsaSha1), rsaIntermediate()])).toEqual(w);
    expect(run([rsaLeaf(OID.ecdsaSha384), rsaIntermediate()])).toEqual(w);
  });
});
