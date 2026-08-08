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
import fixture from './fixtures/attestation-report.json';
import {
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
} from '../attestation-verify';

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
