/**
 * Intel TDX attestation-quote verification — pure JS, OTA-shippable.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app encrypts every cloud inference request toward a public key it is
 * handed by `/api/attestation/report`. Until now the app took that key on
 * faith: it read `model_attestations[0].signing_public_key` and threw the rest
 * of the response away. That means the trust anchor was "Mera plus whoever
 * operates the gateway", not the silicon — anyone able to answer that endpoint
 * could hand us a key they hold the secret for and read every prompt.
 *
 * This module closes that gap by verifying the Intel TDX quote that accompanies
 * the key, and — critically — that the key is the one COMMITTED INSIDE the
 * quote. Verifying a quote's signature chain alone would prove only that *some*
 * genuine enclave exists somewhere; a gateway could serve a real NEAR quote
 * alongside its own substituted pubkey and pass. See CHECK_REPORT_DATA_KEY.
 *
 * FAIL-OPEN, DELIBERATELY (for now)
 * ---------------------------------
 * Nothing here gates inference. `verifyAttestation` reports per-check results
 * for display and the caller ignores them for routing purposes. Two reasons:
 *   1. We do not check platform TCB currency or QE identity (that needs Intel
 *      PCS collateral we don't fetch), so a "fail" here is not yet a complete
 *      statement about the platform.
 *   2. This has never run in the field. Flipping straight to fail-closed would
 *      let one unforeseen encoding quirk brick cloud mode for every user.
 * FLIP TO FAIL-CLOSED once field telemetry shows the pass rate is ~100%. That
 * change belongs at the CALL SITE (refuse to encrypt), not here — this module
 * stays a pure reporter.
 *
 * NO WEBCRYPTO / NO NATIVE MODULES
 * --------------------------------
 * React Native supplies no WebCrypto provider, so the usual X.509 libraries
 * (`@peculiar/x509` and friends) don't work here, and the libraries that do
 * work are native — which would mean this security fix could only ship in a
 * store release. The DER/ASN.1 and X.509 parsing below is therefore hand-rolled
 * over `@noble/curves` + `@noble/hashes`, both already direct dependencies.
 * More code, but it ships over the air.
 *
 * MEASURED WIRE FACTS (captured from a live NEAR AI response, 2026-08-08)
 * ----------------------------------------------------------------------
 * These were verified against a real report, not inferred from documentation:
 *   - `intel_quote` is HEX (not base64, not nested).
 *   - Quote is TDX v4: version=4, att_key_type=2 (ECDSA P-256), tee_type=0x81.
 *     So the primitive is p256 + SHA-256 — NOT p384.
 *   - The FULL PCK chain (leaf → Intel SGX PCK Platform CA → Intel SGX Root CA)
 *     is embedded in the quote itself, so no collateral fetch is needed to
 *     build the chain.
 *   - `report_data` (last 64 bytes of the TD report body) is exactly
 *     `signing_public_key (32B) ‖ request_nonce (32B)`.
 *   - The `nonce` query param IS honoured upstream and lands in that
 *     `report_data`, which is what makes freshness verifiable at all.
 *   - Intel's signatures are HIGH-S. `@noble/curves` rejects those by default
 *     (malleability guard), so every verify below passes `lowS: false`. It also
 *     needs an explicit `prehash: false` because we hand it a digest. Getting
 *     either wrong makes every signature silently fail to verify — which,
 *     fail-open, would look exactly like "the check is running and passing
 *     nothing". Do not remove those options without re-testing against the
 *     fixture.
 */
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

// ─── Result model ────────────────────────────────────────────────────────────

/** `not-checked` is a FIRST-CLASS state, never folded into `pass`. A check we
 *  do not perform must never render as a green tick — that is the difference
 *  between fail-open and misleading the user. */
export type CheckStatus = 'pass' | 'fail' | 'not-checked';

export type CheckId =
  | 'quote-structure'
  | 'report-data-key'
  | 'freshness-nonce'
  | 'signing-algo'
  | 'qe-report-signature'
  | 'attestation-key-binding'
  | 'quote-signature'
  | 'pck-chain'
  | 'root-ca-pin'
  | 'tcb-status'
  | 'gpu-attestation';

export interface CheckResult {
  id: CheckId;
  status: CheckStatus;
  /** Short machine-ish explanation. Safe to display and to log — every value
   *  involved is public attestation data. */
  detail: string;
}

export interface VerificationReport {
  /** Overall verdict, derived from the WEAKEST implemented check (see
   *  {@link summarize}). Never "verified" while something is unchecked. */
  verdict: 'verified' | 'failed' | 'incomplete';
  checks: CheckResult[];
}

// ─── Pinned trust anchor ─────────────────────────────────────────────────────

/**
 * SHA-256 of the DER of the Intel SGX Root CA certificate.
 *
 * THIS CONSTANT IS THE ENTIRE POINT OF THE CHAIN CHECK. The PCK chain travels
 * INSIDE the quote, so an attacker who substitutes the signing key can just as
 * easily substitute all three certificates and a self-signed "root". Verifying
 * only that the chain is internally consistent would be a tautology that
 * verifies nothing.
 *
 * Comparing the received root against this compiled-in hash is what makes the
 * chain meaningful: the attacker would have to produce a certificate that
 * hashes to this value.
 *
 * Captured from a live NEAR AI quote and cross-checked against the certificate
 * subject `CN=Intel SGX Root CA, O=Intel Corporation, L=Santa Clara, ST=CA,
 * C=US` (valid to 2049-12-31).
 */
export const INTEL_SGX_ROOT_CA_DER_SHA256 =
  '44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3';

// ─── Quote layout constants (TDX v4) ─────────────────────────────────────────

const QUOTE_HEADER_LEN = 48;
/** TDReport10 — the body the quote signature covers along with the header. */
const TD_REPORT_LEN = 584;
/** `report_data` is the final 64 bytes of the TD report body. */
const REPORT_DATA_LEN = 64;
const ECDSA_SIG_LEN = 64;
const ECDSA_PUBKEY_RAW_LEN = 64;
/** QE report is an SGX Report body. Its own `report_data` sits at offset 320. */
const QE_REPORT_LEN = 384;
const QE_REPORT_DATA_OFFSET = 320;

const EXPECTED_QUOTE_VERSION = 4;
/** 2 = ECDSA-256-with-P-256. This is what fixes the curve as p256/sha256. */
const EXPECTED_ATT_KEY_TYPE = 2;
/** 0x81 = TDX (0x00 would be SGX). */
const EXPECTED_TEE_TYPE = 0x81;
/** qe_cert_data type 6 = QE report + signature + inner cert data. */
const CERT_TYPE_QE_REPORT = 6;
/** Inner qe_cert_data type 5 = PEM PCK certificate chain. */
const CERT_TYPE_PCK_CHAIN = 5;

// ─── Small byte helpers ──────────────────────────────────────────────────────

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('Invalid hex string (odd length)');
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error('Invalid hex string (non-hex char)');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, '0');
  return hex;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function readU16LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function readU32LE(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

// ─── Minimal DER / ASN.1 ─────────────────────────────────────────────────────
// Only what X.509 certificate parsing needs: definite-length TLVs, SEQUENCE
// walking, BIT STRING payloads. No indefinite lengths (illegal in DER), no
// streaming. Anything malformed throws rather than returning a partial parse —
// a lenient parser here would be a way to smuggle a bad certificate past the
// chain check.

interface Asn1Node {
  tag: number;
  /** Offset of the first content byte within the buffer. */
  contentStart: number;
  contentLength: number;
  /** Offset one past the end of this whole TLV — where the next TLV starts. */
  end: number;
}

function readTlv(buf: Uint8Array, offset: number): Asn1Node {
  if (offset + 2 > buf.length) throw new Error('DER: truncated tag/length');
  const tag = buf[offset];
  let p = offset + 1;
  const first = buf[p++];
  let contentLength: number;
  if (first < 0x80) {
    contentLength = first;
  } else {
    const n = first & 0x7f;
    // 0x80 is the indefinite form — forbidden in DER. >4 length bytes would be
    // a >4GB object; either way this is not a certificate we should parse.
    if (n === 0 || n > 4) throw new Error(`DER: bad length form (0x${first.toString(16)})`);
    if (p + n > buf.length) throw new Error('DER: truncated length');
    contentLength = 0;
    for (let i = 0; i < n; i++) contentLength = contentLength * 256 + buf[p++];
  }
  const contentStart = p;
  const end = contentStart + contentLength;
  if (end > buf.length) throw new Error('DER: content overruns buffer');
  return { tag, contentStart, contentLength, end };
}

/** Children of a constructed TLV, in order. */
function derChildren(buf: Uint8Array, node: Asn1Node): Asn1Node[] {
  const out: Asn1Node[] = [];
  let p = node.contentStart;
  while (p < node.end) {
    const child = readTlv(buf, p);
    out.push(child);
    p = child.end;
  }
  return out;
}

function nodeBytes(buf: Uint8Array, node: Asn1Node): Uint8Array {
  return buf.subarray(node.contentStart, node.end);
}

// ─── Minimal X.509 ───────────────────────────────────────────────────────────

export interface ParsedCertificate {
  /** DER of the full certificate — hashed for the root-CA pin. */
  der: Uint8Array;
  /** DER of the `tbsCertificate`, exactly the bytes the signature covers. */
  tbs: Uint8Array;
  /** Raw uncompressed P-256 point (65 bytes, 0x04 ‖ x ‖ y). */
  publicKey: Uint8Array;
  /** ECDSA signature as raw r‖s (64 bytes), converted from the DER form. */
  signature: Uint8Array;
  notBefore: Date;
  notAfter: Date;
}

/**
 * Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
 * tbsCertificate ::= SEQUENCE { [0] version, serial, sigAlg, issuer,
 *                               validity, subject, subjectPublicKeyInfo, ... }
 */
export function parseCertificate(der: Uint8Array): ParsedCertificate {
  const root = readTlv(der, 0);
  if (root.tag !== 0x30) throw new Error('X509: root is not a SEQUENCE');
  const top = derChildren(der, root);
  if (top.length < 3) throw new Error('X509: certificate needs 3 elements');

  const tbsNode = top[0];
  if (tbsNode.tag !== 0x30) throw new Error('X509: tbsCertificate is not a SEQUENCE');
  // The signature covers the tbsCertificate TLV *including* its header. We know
  // it starts at offset 0 of the cert content, so reconstruct its span from the
  // root's content start.
  const tbs = der.subarray(root.contentStart, tbsNode.end);

  const sigNode = top[2];
  if (sigNode.tag !== 0x03) throw new Error('X509: signatureValue is not a BIT STRING');
  // BIT STRING content begins with an "unused bits" byte, always 0 here.
  const sigDer = der.subarray(sigNode.contentStart + 1, sigNode.end);
  const signature = derSignatureToRaw(sigDer);

  // Walk the tbsCertificate.
  const tbsKids = derChildren(der, tbsNode);
  let i = 0;
  // [0] EXPLICIT version — context-specific constructed tag 0xA0, optional.
  if (tbsKids[i]?.tag === 0xa0) i++;
  i++; // serialNumber
  i++; // signature (AlgorithmIdentifier)
  i++; // issuer
  const validityNode = tbsKids[i++];
  if (!validityNode || validityNode.tag !== 0x30) {
    throw new Error('X509: validity is not a SEQUENCE');
  }
  const [nbNode, naNode] = derChildren(der, validityNode);
  const notBefore = parseAsn1Time(nbNode, der);
  const notAfter = parseAsn1Time(naNode, der);
  i++; // subject
  const spkiNode = tbsKids[i];
  if (!spkiNode || spkiNode.tag !== 0x30) {
    throw new Error('X509: subjectPublicKeyInfo is not a SEQUENCE');
  }
  const spkiKids = derChildren(der, spkiNode);
  const keyBits = spkiKids[1];
  if (!keyBits || keyBits.tag !== 0x03) {
    throw new Error('X509: subjectPublicKey is not a BIT STRING');
  }
  const publicKey = der.subarray(keyBits.contentStart + 1, keyBits.end);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error(
      `X509: expected a 65-byte uncompressed EC point, got ${publicKey.length} bytes`,
    );
  }

  return { der, tbs, publicKey, signature, notBefore, notAfter };
}

/** ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER } → raw 32‖32. */
export function derSignatureToRaw(sig: Uint8Array): Uint8Array {
  const seq = readTlv(sig, 0);
  if (seq.tag !== 0x30) throw new Error('DER sig: not a SEQUENCE');
  const [rNode, sNode] = derChildren(sig, seq);
  if (!rNode || !sNode || rNode.tag !== 0x02 || sNode.tag !== 0x02) {
    throw new Error('DER sig: r/s are not INTEGERs');
  }
  const out = new Uint8Array(64);
  out.set(trimToLength(nodeBytes(sig, rNode), 32), 0);
  out.set(trimToLength(nodeBytes(sig, sNode), 32), 32);
  return out;
}

/** DER INTEGERs are signed and minimally encoded, so a 32-byte value may arrive
 *  with a leading 0x00 pad (33 bytes) or short of 32 bytes. Normalise to 32. */
function trimToLength(v: Uint8Array, len: number): Uint8Array {
  let start = 0;
  while (start < v.length - 1 && v[start] === 0) start++;
  const trimmed = v.subarray(start);
  if (trimmed.length > len) throw new Error('DER sig: integer too large');
  const out = new Uint8Array(len);
  out.set(trimmed, len - trimmed.length);
  return out;
}

/** UTCTime (YYMMDDHHMMSSZ) or GeneralizedTime (YYYYMMDDHHMMSSZ). */
function parseAsn1Time(node: Asn1Node | undefined, buf: Uint8Array): Date {
  if (!node) throw new Error('X509: missing time');
  const s = new TextDecoder().decode(nodeBytes(buf, node));
  const m =
    node.tag === 0x17
      ? s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/)
      : s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) throw new Error(`X509: unparseable time "${s}"`);
  let year = parseInt(m[1], 10);
  // RFC 5280: UTCTime years 50-99 are 19xx, 00-49 are 20xx.
  if (node.tag === 0x17) year += year >= 50 ? 1900 : 2000;
  return new Date(
    Date.UTC(year, parseInt(m[2], 10) - 1, +m[3], +m[4], +m[5], +m[6]),
  );
}

/** Split a PEM bundle into DER buffers, in order. */
export function pemToDerList(pem: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pem)) !== null) {
    out.push(base64ToBytes(m[1].replace(/\s+/g, '')));
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64.indexOf(clean[i]);
    if (v < 0) throw new Error('Invalid base64 in PEM');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

// ─── P-256 verification wrapper ──────────────────────────────────────────────

/**
 * Verify a raw r‖s P-256 signature over `message` (hashed with SHA-256 here).
 *
 * `lowS: false` — Intel does NOT normalise signatures to the low-s form, and
 * noble rejects high-s by default as a malleability guard. That guard is about
 * signature *malleability* (two encodings of one signature), which matters for
 * systems that use signatures as identifiers; it does not weaken verification.
 * `prehash: false` — we pass a digest, not the message.
 * Both were established empirically against a live quote; without them every
 * verification below returns false.
 */
function verifyP256(sig: Uint8Array, message: Uint8Array, pubkey: Uint8Array): boolean {
  try {
    return p256.verify(sig, sha256(message), pubkey, { lowS: false, prehash: false });
  } catch {
    // A malformed point/signature is a verification failure, not a crash.
    return false;
  }
}

// ─── Quote parsing ───────────────────────────────────────────────────────────

export interface ParsedQuote {
  version: number;
  attKeyType: number;
  teeType: number;
  /** header ‖ td_report — exactly what the quote signature covers. */
  signedBody: Uint8Array;
  /** Last 64 bytes of the TD report body. */
  reportData: Uint8Array;
  /** Raw 64-byte r‖s over `signedBody`, made by the attestation key. */
  quoteSignature: Uint8Array;
  /** Raw 64-byte P-256 attestation public key (x‖y, no 0x04 prefix). */
  attestationKey: Uint8Array;
  qeReport: Uint8Array;
  qeSignature: Uint8Array;
  qeAuthData: Uint8Array;
  /** leaf → intermediate → root. */
  certChain: Uint8Array[];
}

export function parseQuote(quoteHex: string): ParsedQuote {
  const q = hexToBytes(quoteHex);
  if (q.length < QUOTE_HEADER_LEN + TD_REPORT_LEN + 4) {
    throw new Error(`Quote too short (${q.length} bytes)`);
  }
  const version = readU16LE(q, 0);
  const attKeyType = readU16LE(q, 2);
  const teeType = readU32LE(q, 4);

  const bodyEnd = QUOTE_HEADER_LEN + TD_REPORT_LEN;
  const signedBody = q.subarray(0, bodyEnd);
  const reportData = q.subarray(bodyEnd - REPORT_DATA_LEN, bodyEnd);

  let o = bodyEnd;
  const sigDataLen = readU32LE(q, o);
  o += 4;
  if (o + sigDataLen > q.length) {
    throw new Error(`Quote signature section overruns (len=${sigDataLen})`);
  }
  const quoteSignature = q.subarray(o, o + ECDSA_SIG_LEN);
  o += ECDSA_SIG_LEN;
  const attestationKey = q.subarray(o, o + ECDSA_PUBKEY_RAW_LEN);
  o += ECDSA_PUBKEY_RAW_LEN;

  const certType = readU16LE(q, o);
  o += 6; // type(2) + size(4)
  if (certType !== CERT_TYPE_QE_REPORT) {
    throw new Error(`Unsupported qe_cert_data type ${certType} (expected ${CERT_TYPE_QE_REPORT})`);
  }
  const qeReport = q.subarray(o, o + QE_REPORT_LEN);
  o += QE_REPORT_LEN;
  const qeSignature = q.subarray(o, o + ECDSA_SIG_LEN);
  o += ECDSA_SIG_LEN;
  const authLen = readU16LE(q, o);
  o += 2;
  const qeAuthData = q.subarray(o, o + authLen);
  o += authLen;

  const innerType = readU16LE(q, o);
  const innerSize = readU32LE(q, o + 2);
  o += 6;
  if (innerType !== CERT_TYPE_PCK_CHAIN) {
    throw new Error(`Unsupported inner cert type ${innerType} (expected ${CERT_TYPE_PCK_CHAIN})`);
  }
  const pem = new TextDecoder().decode(q.subarray(o, o + innerSize));
  const certChain = pemToDerList(pem);

  return {
    version,
    attKeyType,
    teeType,
    signedBody,
    reportData,
    quoteSignature,
    attestationKey,
    qeReport,
    qeSignature,
    qeAuthData,
    certChain,
  };
}

// ─── The verification itself ─────────────────────────────────────────────────

export interface AttestationInput {
  /** Hex `intel_quote` from `model_attestations[0]`. */
  quoteHex: string;
  /** Hex `signing_public_key` — the key the app would encrypt toward. */
  signingPublicKey: string;
  /** Attested `signing_algo` string, cross-checked against the key length. */
  signingAlgo?: string;
  /** The nonce THIS CLIENT generated for this request. Omit when the report
   *  came from a cached/nonce-free fetch — freshness is then `not-checked`
   *  rather than falsely passing. */
  expectedNonce?: string;
  /** Whether a GPU attestation blob was present (reported, never verified). */
  hasGpuPayload?: boolean;
  /** Injectable for tests; defaults to now. */
  now?: Date;
}

/**
 * Run every implemented check and return per-check results.
 *
 * NEVER THROWS for attestation-content reasons — a malformed quote is a
 * `fail` on `quote-structure`, not an exception, because the caller is a
 * settings screen that must render something either way.
 */
export function verifyAttestation(input: AttestationInput): VerificationReport {
  const checks: CheckResult[] = [];
  const add = (id: CheckId, status: CheckStatus, detail: string) =>
    checks.push({ id, status, detail });

  // These two never depend on the quote parsing, so they are computed even if
  // the quote is garbage.
  const keyBytes = (() => {
    try {
      return hexToBytes(input.signingPublicKey);
    } catch {
      return null;
    }
  })();

  let quote: ParsedQuote;
  try {
    quote = parseQuote(input.quoteHex);
  } catch (e) {
    add('quote-structure', 'fail', (e as Error).message);
    // Without a parsed quote nothing else can be evaluated. Report the rest as
    // not-checked rather than inventing failures.
    for (const id of [
      'report-data-key',
      'freshness-nonce',
      'qe-report-signature',
      'attestation-key-binding',
      'quote-signature',
      'pck-chain',
      'root-ca-pin',
    ] as CheckId[]) {
      add(id, 'not-checked', 'quote could not be parsed');
    }
    addAlgoCheck(add, input.signingAlgo, keyBytes);
    addUncheckable(add, input.hasGpuPayload);
    return summarize(checks);
  }

  // 1. Structure — reject unexpected shapes instead of guessing at offsets.
  if (
    quote.version === EXPECTED_QUOTE_VERSION &&
    quote.attKeyType === EXPECTED_ATT_KEY_TYPE &&
    quote.teeType === EXPECTED_TEE_TYPE
  ) {
    add(
      'quote-structure',
      'pass',
      `TDX quote v${quote.version}, ECDSA P-256, tee_type 0x${quote.teeType.toString(16)}`,
    );
  } else {
    add(
      'quote-structure',
      'fail',
      `unexpected quote shape: version=${quote.version} att_key_type=${quote.attKeyType} tee_type=0x${quote.teeType.toString(16)}`,
    );
  }

  // 2. report_data → signing key. THE check. Verifying the chain proves only
  //    that a genuine enclave exists; this proves the key we encrypt toward is
  //    the one that enclave committed to. Without it a gateway can serve a real
  //    NEAR quote next to its own key and read every prompt.
  const committedKey = quote.reportData.subarray(0, 32);
  if (keyBytes && keyBytes.length === 32 && equalBytes(committedKey, keyBytes)) {
    add('report-data-key', 'pass', `signing key is committed in the quote's report_data`);
  } else {
    add(
      'report-data-key',
      'fail',
      `report_data commits ${bytesToHex(committedKey)} but the served key is ${input.signingPublicKey}`,
    );
  }

  // 3. Freshness. The quote embeds whatever nonce the request carried, so a
  //    client-chosen nonce is the only defence against replay — the report is
  //    cached 30 min client-side, 10 min gateway-side, and (measured) upstream
  //    too. Without a nonce this is `not-checked`, never `pass`.
  const nonceInQuote = quote.reportData.subarray(32, 64);
  if (!input.expectedNonce) {
    add(
      'freshness-nonce',
      'not-checked',
      'no client nonce was sent, so this report may be cached/replayed',
    );
  } else {
    let expected: Uint8Array | null = null;
    try {
      expected = hexToBytes(input.expectedNonce);
    } catch {
      expected = null;
    }
    if (expected && equalBytes(nonceInQuote, expected)) {
      add('freshness-nonce', 'pass', 'quote commits this request’s nonce');
    } else {
      add(
        'freshness-nonce',
        'fail',
        `quote commits nonce ${bytesToHex(nonceInQuote)}, expected ${input.expectedNonce}`,
      );
    }
  }

  // 4. signing_algo vs key length — the app elsewhere infers the algo purely
  //    from byte length, so cross-check the attested string against it.
  addAlgoCheck(add, input.signingAlgo, keyBytes);

  // 5-8: the signature chain.
  const leafDer = quote.certChain[0];
  let leaf: ParsedCertificate | null = null;
  try {
    leaf = leafDer ? parseCertificate(leafDer) : null;
  } catch {
    leaf = null;
  }

  // 5. QE report signed by the PCK leaf certificate.
  if (!leaf) {
    add('qe-report-signature', 'not-checked', 'PCK leaf certificate could not be parsed');
  } else if (verifyP256(quote.qeSignature, quote.qeReport, leaf.publicKey)) {
    add('qe-report-signature', 'pass', 'QE report signed by the PCK leaf certificate');
  } else {
    add('qe-report-signature', 'fail', 'QE report signature did not verify');
  }

  // 6. Attestation key bound into the QE report. This is the link that anchors
  //    the quote signature to the certified hardware — without it the quote
  //    signature is made by an unattested key and proves nothing.
  const expectedDigest = sha256(concat(quote.attestationKey, quote.qeAuthData));
  const qeReportData = quote.qeReport.subarray(
    QE_REPORT_DATA_OFFSET,
    QE_REPORT_DATA_OFFSET + 32,
  );
  if (equalBytes(expectedDigest, qeReportData)) {
    add('attestation-key-binding', 'pass', 'attestation key is bound into the QE report');
  } else {
    add(
      'attestation-key-binding',
      'fail',
      'SHA-256(attestation key ‖ auth data) does not match the QE report_data',
    );
  }

  // 7. Quote signature over header ‖ TD report, by the attestation key.
  const attPub = concat(new Uint8Array([0x04]), quote.attestationKey);
  if (verifyP256(quote.quoteSignature, quote.signedBody, attPub)) {
    add('quote-signature', 'pass', 'quote body signed by the attestation key');
  } else {
    add('quote-signature', 'fail', 'quote signature did not verify');
  }

  // 8. PCK chain + pinned root.
  verifyChain(quote.certChain, input.now ?? new Date(), add);

  addUncheckable(add, input.hasGpuPayload);
  return summarize(checks);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function addAlgoCheck(
  add: (id: CheckId, s: CheckStatus, d: string) => void,
  signingAlgo: string | undefined,
  keyBytes: Uint8Array | null,
): void {
  if (!signingAlgo) {
    add('signing-algo', 'not-checked', 'no signing_algo was reported');
    return;
  }
  if (!keyBytes) {
    add('signing-algo', 'fail', 'signing_public_key is not valid hex');
    return;
  }
  // The mapping the rest of the app uses: 32 → ed25519, 64 → ecdsa (secp256k1).
  const expected = keyBytes.length === 32 ? 'ed25519' : keyBytes.length === 64 ? 'ecdsa' : null;
  if (expected === null) {
    add('signing-algo', 'fail', `unsupported key length ${keyBytes.length}`);
  } else if (expected === signingAlgo) {
    add('signing-algo', 'pass', `${signingAlgo} matches the ${keyBytes.length}-byte key`);
  } else {
    add(
      'signing-algo',
      'fail',
      `attested algo "${signingAlgo}" disagrees with the ${keyBytes.length}-byte key (expected "${expected}")`,
    );
  }
}

/** Checks we deliberately do NOT perform. Reported so the UI can show them as
 *  unchecked — a security screen that silently omits what it skipped is worse
 *  than one that admits it. */
function addUncheckable(
  add: (id: CheckId, s: CheckStatus, d: string) => void,
  hasGpuPayload: boolean | undefined,
): void {
  add(
    'tcb-status',
    'not-checked',
    'platform TCB currency and QE identity need Intel PCS collateral, which the app does not fetch',
  );
  add(
    'gpu-attestation',
    'not-checked',
    hasGpuPayload
      ? 'a GPU attestation payload was served but verifying it needs NVIDIA’s NRAS service'
      : 'no GPU attestation payload was served',
  );
}

/**
 * leaf ← intermediate ← root, every signature checked, and the root compared
 * against the compiled-in pin. The pin is what makes this non-circular: the
 * chain arrives inside the quote, so self-consistency alone proves nothing.
 */
function verifyChain(
  chain: Uint8Array[],
  now: Date,
  add: (id: CheckId, s: CheckStatus, d: string) => void,
): void {
  if (chain.length < 2) {
    add('pck-chain', 'fail', `expected at least 2 certificates, got ${chain.length}`);
    add('root-ca-pin', 'not-checked', 'no chain to anchor');
    return;
  }
  let certs: ParsedCertificate[];
  try {
    certs = chain.map(parseCertificate);
  } catch (e) {
    add('pck-chain', 'fail', `certificate parse failed: ${(e as Error).message}`);
    add('root-ca-pin', 'not-checked', 'chain could not be parsed');
    return;
  }

  // Root pin FIRST — if the anchor is wrong, the links do not matter.
  const root = certs[certs.length - 1];
  const rootHash = bytesToHex(sha256(root.der));
  const pinned = rootHash === INTEL_SGX_ROOT_CA_DER_SHA256;
  add(
    'root-ca-pin',
    pinned ? 'pass' : 'fail',
    pinned
      ? 'chain anchors to the pinned Intel SGX Root CA'
      : `root certificate ${rootHash} is not the pinned Intel SGX Root CA`,
  );

  const problems: string[] = [];
  for (let i = 0; i < certs.length; i++) {
    const c = certs[i];
    if (now < c.notBefore || now > c.notAfter) {
      problems.push(`certificate ${i} is outside its validity window`);
    }
    // Each certificate is signed by the NEXT one; the root signs itself.
    const issuer = certs[Math.min(i + 1, certs.length - 1)];
    if (!verifyP256(c.signature, c.tbs, issuer.publicKey)) {
      problems.push(`certificate ${i} signature did not verify against its issuer`);
    }
  }
  if (problems.length === 0) {
    add('pck-chain', 'pass', `${certs.length}-certificate PCK chain verified`);
  } else {
    add('pck-chain', 'fail', problems.join('; '));
  }
}

/**
 * Overall verdict from the WEAKEST implemented check.
 *
 * Any `fail` → failed. Otherwise, because TCB and GPU are always unchecked,
 * the best available verdict is `incomplete`, and only a build that checks
 * everything could ever return `verified`. That asymmetry is intentional: a
 * green "verified" next to a list containing unchecked items is precisely the
 * decorative outcome this feature exists to avoid.
 */
export function summarize(checks: CheckResult[]): VerificationReport {
  const verdict = checks.some(c => c.status === 'fail')
    ? 'failed'
    : checks.some(c => c.status === 'not-checked')
      ? 'incomplete'
      : 'verified';
  return { verdict, checks };
}
