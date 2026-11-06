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
 *
 * NVIDIA GPU ATTESTATION (`verifyNvidiaAttestation`)
 * --------------------------------------------------
 * A pass means NVIDIA attested the GPUs: genuine NVIDIA GPUs answered with this
 * nonce. It never shows those GPUs are attached to the enclave, so no comment
 * or copy may say so.
 *
 * The phone never contacts NVIDIA. The gateway relays the NRAS tokens and the
 * JWKS entries for their `kid`s, and the gateway is untrusted, so only the
 * compiled-in root and the signatures count. The gateway-carried `x`/`y` are
 * never read.
 *
 * What proves the nonce, as OBSERVED NRAS behaviour (black-box, five runs, 8
 * GPUs), not a documented guarantee: `eat_nonce` only copies the request's nonce
 * and reads as forged even when verification fails, so it ties a token to this
 * request and proves nothing about the GPU. The proof is in the verdict claims.
 * NRAS compares the request nonce with bytes inside the evidence blob, and the
 * GPU's signature covers those bytes. Forging the top-level nonce gave overall
 * false and nonce-match false; forging the blob bytes too gave nonce-match true
 * and report-signature-verified false. On a mismatch NRAS answers some of these
 * with null, so every claim is compared strictly and null is a `fail`. NRAS
 * ignores the per-GPU JSON `nonce` field in the evidence: never read it.
 *
 * `fail` is only a bad token signature under a valid chain, a nonce mismatch, or
 * a signed claim that is not the required value. Everything else is
 * `not-checked`, because it says nothing about the GPUs and must not turn every
 * install red: a certificate count other than 2, an unknown algorithm, an
 * unknown root, a certificate outside validity, a token outside its time window
 * (the nonce rules out an old token, so that is the phone's clock), anything over
 * a cap, and any shape this build cannot read. Token `nbf`/`exp` get 60 seconds
 * of leeway, the default in NVIDIA's SDK: `nbf` is the moment of minting, so a
 * phone a few seconds behind would otherwise never see a genuine token as valid.
 *
 * Trust anchor: the self-signed `NVIDIA Attestation Service CA 001`, valid to
 * 2055-12-03, compiled in and never relayed. It came from
 * https://prod.vault.nvidia.com/v1/dgxc-attestation/pki/nras-prod/ca_chain, a URL
 * NVIDIA does not document. It validates both live intermediates, and its key is
 * the one recoverable from their signatures. Intermediate 004 has an RSA-2048 key
 * and expires 2029-12-08, so its leaves are RSA-signed and this file carries RSA
 * as well as P-384. Intermediate 005 is P-384 and expires 2030-10-08. Leaves live
 * 12 to 48 hours and token `exp` is `iat` + 1h.
 *
 * Revocation is not checked and cannot be: OCSP and CRL are NVIDIA hosts, and the
 * phone does not contact NVIDIA.
 *
 * BasicConstraints is deliberately not parsed. Exact depth (leaf, intermediate,
 * pinned root) means only a certificate signed directly by the root can issue,
 * which assumes the root issues no end-entity certificate outside NVIDIA's
 * control.
 *
 * IF THIS CHECK EVER BLOCKS ANYTHING, absent tokens must count as failure: a
 * gateway can always strip the tokens to get `not-checked`.
 */
import { mod, pow2 } from '@noble/curves/abstract/modular.js';
import { p256, p384 } from '@noble/curves/nist.js';
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';
import { sha256, sha384 } from '@noble/hashes/sha2.js';

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
  | 'gpu-attestation'
  | 'deployed-software';

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

/** ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER } → raw r‖s, each `width`
 *  bytes: 32 for P-256, 48 for P-384. */
export function derSignatureToRaw(sig: Uint8Array, width = 32): Uint8Array {
  const seq = readTlv(sig, 0);
  if (seq.tag !== 0x30) throw new Error('DER sig: not a SEQUENCE');
  const [rNode, sNode] = derChildren(sig, seq);
  if (!rNode || !sNode || rNode.tag !== 0x02 || sNode.tag !== 0x02) {
    throw new Error('DER sig: r/s are not INTEGERs');
  }
  const out = new Uint8Array(width * 2);
  out.set(trimToLength(nodeBytes(sig, rNode), width), 0);
  out.set(trimToLength(nodeBytes(sig, sNode), width), width);
  return out;
}

/** DER INTEGERs are signed and minimally encoded, so a 32-byte value may arrive
 *  with a leading 0x00 pad (33 bytes) or short of 32 bytes. Normalise to `len`. */
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
  /** Whether a GPU attestation blob was present. Only words the `not-checked`
   *  detail when no NVIDIA token arrived. */
  hasGpuPayload?: boolean;
  /** `model_attestations[i].nvidia_attestation`, untouched. `unknown` because the
   *  gateway is untrusted: {@link verifyNvidiaAttestation} is what reads it. */
  nvidiaAttestation?: unknown;
  /** The result of `checkDeployedSoftware`, which is async and so runs first. */
  deployedSoftware?: { status: CheckStatus; detail: string };
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
    addUncheckable(add);
    addGpuCheck(add, input);
    addDeployedSoftware(add, input);
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

  addUncheckable(add);
  addGpuCheck(add, input);
  addDeployedSoftware(add, input);
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
function addUncheckable(add: (id: CheckId, s: CheckStatus, d: string) => void): void {
  add(
    'tcb-status',
    'not-checked',
    'platform TCB currency and QE identity need Intel PCS collateral, which the app does not fetch',
  );
}

function addGpuCheck(
  add: (id: CheckId, s: CheckStatus, d: string) => void,
  input: AttestationInput,
): void {
  if (input.nvidiaAttestation === undefined || input.nvidiaAttestation === null) {
    add(
      'gpu-attestation',
      'not-checked',
      input.hasGpuPayload
        ? 'a GPU attestation payload was served, but no NVIDIA token came with it'
        : 'no GPU attestation payload was served',
    );
    return;
  }
  const { status, detail } = verifyNvidiaAttestation(
    input.nvidiaAttestation,
    input.expectedNonce,
    input.now ?? new Date(),
  );
  add('gpu-attestation', status, detail);
}

function addDeployedSoftware(
  add: (id: CheckId, s: CheckStatus, d: string) => void,
  input: AttestationInput,
): void {
  const { status, detail } = input.deployedSoftware ?? {
    status: 'not-checked',
    detail: 'the deployment log was not checked',
  };
  add('deployed-software', status, detail);
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

// ─── NVIDIA GPU attestation ──────────────────────────────────────────────────
// The rules, and what a pass may and may not claim, are in the file header.

/** SHA-256 of the pinned root's DER. A test ties it to the base64 below. */
export const NVIDIA_NRAS_ROOT_CA_DER_SHA256 =
  'cde269e3f72c667aecc2d8c1ab32c4e42aaf5507379f15f221c77c5518101a1e';

/** `CN=NVIDIA Attestation Service CA 001`, standard base64 DER. Never relayed. */
export const NVIDIA_NRAS_ROOT_CA_DER_B64 =
  'MIICUDCCAdagAwIBAgIUF11XI0bGzc7WYhmjf6qrdvR1ntYwCgYIKoZIzj0EAwMwVjELMAkGA1UEBhMCVVMxGzAZBgNVBAoMEk5WSURJQSBDb3Jwb3JhdGlvbjEqMCgGA1UEAwwhTlZJRElBIEF0dGVzdGF0aW9uIFNlcnZpY2UgQ0EgMDAxMCAXDTI1MTIxMDAwMTg1MVoYDzIwNTUxMjAzMDAxODUxWjBWMQswCQYDVQQGEwJVUzEbMBkGA1UECgwSTlZJRElBIENvcnBvcmF0aW9uMSowKAYDVQQDDCFOVklESUEgQXR0ZXN0YXRpb24gU2VydmljZSBDQSAwMDEwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAASQz1nh45YSHgbSQtZ99x0Y+i+l4HkK7sEA48ZmaW3BoI4yndSr2B7+O80zJpDuB567TqbJZYkSkBpYV0huK6v4oJ3K8jCG+j6mTEBwW/NxUJCo+3zQQYPvdr9HV9a039mjYzBhMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBS+Cm/tecJIqoo3Cyb2hTcxbHIEvzAfBgNVHSMEGDAWgBS+Cm/tecJIqoo3Cyb2hTcxbHIEvzAKBggqhkjOPQQDAwNoADBlAjA7uesOrKwGhWEkZhSnXEVaMVIDbXe+ThfWz02dXBCDjytfIMcvpjnhrLK+jN1+YZsCMQCU+1mar0sQ7kFvSsvSGbGgEBv8DQNuNFhF8MS3L2EYuOBzIY0rUStYQago+aIYpyY=';

const NRAS_ISSUER = 'https://nras.attestation.nvidia.com';
const NRAS_CLOCK_LEEWAY_S = 60;
const MAX_GPU_TOKENS = 16;
const MAX_NRAS_KEYS = 8;
const MIN_RSA_MODULUS_BYTES = 256;
const MAX_RSA_MODULUS_BYTES = 512;
const RSA_EXPONENT_65537 = '010001';
const GPU_NAME = /^GPU-\d+$/;

const OID_EC_PUBLIC_KEY = '2a8648ce3d0201';
const OID_SECP384R1 = '2b81040022';
const OID_RSA_ENCRYPTION = '2a864886f70d010101';
const OID_ECDSA_SHA384 = '2a8648ce3d040303';
const OID_RSA_SHA256 = '2a864886f70d01010b';

/** DER prefix of an EMSA-PKCS1-v1_5 DigestInfo for SHA-256 (RFC 8017, 9.2). */
const SHA256_DIGEST_INFO = '3031300d060960864801650304020105000420';

class NvidiaCheckStop extends Error {
  constructor(
    readonly status: 'fail' | 'not-checked',
    detail: string,
  ) {
    super(detail);
  }
}
const rejected = (detail: string) => new NvidiaCheckStop('fail', detail);
const unsupported = (detail: string) => new NvidiaCheckStop('not-checked', detail);

type NrasKey = { kind: 'p384'; point: Uint8Array } | { kind: 'rsa'; modulus: Uint8Array };

interface NrasCertificate {
  tbs: Uint8Array;
  /** Read from inside tbsCertificate, so the signature covers its own algorithm. */
  signatureOid: string;
  /** The signatureValue payload: DER for ECDSA, raw for RSA. */
  signature: Uint8Array;
  key: NrasKey;
  notBefore: Date;
  notAfter: Date;
}

function parseNrasKey(der: Uint8Array, spki: Asn1Node): NrasKey {
  const [algorithm, keyBits] = derChildren(der, spki);
  const [algorithmOid, parameters] = derChildren(der, algorithm);
  const oid = bytesToHex(nodeBytes(der, algorithmOid));
  const bits = der.subarray(keyBits.contentStart + 1, keyBits.end);
  if (
    oid === OID_EC_PUBLIC_KEY &&
    bytesToHex(nodeBytes(der, parameters)) === OID_SECP384R1 &&
    bits.length === 97 &&
    bits[0] === 0x04
  ) {
    return { kind: 'p384', point: bits };
  }
  if (oid === OID_RSA_ENCRYPTION) {
    const [n, e] = derChildren(bits, readTlv(bits, 0));
    const raw = nodeBytes(bits, n);
    // A DER INTEGER with its top bit set carries one 0x00 pad, which is not modulus.
    const modulus = raw[0] === 0 ? raw.subarray(1) : raw;
    if (
      modulus.length >= MIN_RSA_MODULUS_BYTES &&
      modulus.length <= MAX_RSA_MODULUS_BYTES &&
      modulus[0] & 0x80 &&
      bytesToHex(nodeBytes(bits, e)) === RSA_EXPONENT_65537
    ) {
      return { kind: 'rsa', modulus };
    }
  }
  throw unsupported('unsupported certificate key');
}

/** Separate from {@link parseCertificate}, which stays strict P-256 for Intel. */
function parseNrasCertificate(der: Uint8Array): NrasCertificate {
  const root = readTlv(der, 0);
  const [tbsNode, , signatureNode] = derChildren(der, root);
  const fields = derChildren(der, tbsNode);
  // [0] EXPLICIT version is optional; then serial, signature, issuer, validity,
  // subject, subjectPublicKeyInfo.
  const [, signatureAlgorithm, , validity, , spki] = fields.slice(fields[0].tag === 0xa0 ? 1 : 0);
  const [notBefore, notAfter] = derChildren(der, validity);
  return {
    tbs: der.subarray(root.contentStart, tbsNode.end),
    signatureOid: bytesToHex(nodeBytes(der, derChildren(der, signatureAlgorithm)[0])),
    signature: der.subarray(signatureNode.contentStart + 1, signatureNode.end),
    key: parseNrasKey(der, spki),
    notBefore: parseAsn1Time(notBefore, der),
    notAfter: parseAsn1Time(notAfter, der),
  };
}

/** `lowS: false` and `prehash: false` for the reasons in {@link verifyP256}: both
 *  were needed against real NRAS tokens, whose signatures are also high-s. */
function verifyP384(sig: Uint8Array, message: Uint8Array, pubkey: Uint8Array): boolean {
  try {
    return p384.verify(sig, sha384(message), pubkey, { lowS: false, prehash: false });
  } catch {
    return false;
  }
}

/** RSASSA-PKCS1-v1_5 with SHA-256 and e = 65537, the only exponent the parser lets
 *  through. The whole encoded block is compared instead of parsing its padding,
 *  which is what closes the signature-forgery class that parsing leaves open. */
function verifyRsaSha256(sig: Uint8Array, message: Uint8Array, modulus: Uint8Array): boolean {
  const k = modulus.length;
  if (sig.length !== k) return false;
  const n = bytesToNumberBE(modulus);
  const s = bytesToNumberBE(sig);
  if (s >= n) return false;
  // s^65537 is sixteen squarings and one multiply.
  const encoded = numberToBytesBE(mod(pow2(s, BigInt(16), n) * s, n), k);
  const digestInfo = concat(hexToBytes(SHA256_DIGEST_INFO), sha256(message));
  const expected = new Uint8Array(k).fill(0xff);
  expected[0] = 0;
  expected[1] = 1;
  expected[k - digestInfo.length - 1] = 0;
  expected.set(digestInfo, k - digestInfo.length);
  return equalBytes(encoded, expected);
}

function signedBy(cert: NrasCertificate, issuer: NrasKey): boolean {
  if (cert.signatureOid === OID_ECDSA_SHA384 && issuer.kind === 'p384') {
    return verifyP384(derSignatureToRaw(cert.signature, 48), cert.tbs, issuer.point);
  }
  if (cert.signatureOid === OID_RSA_SHA256 && issuer.kind === 'rsa') {
    return verifyRsaSha256(cert.signature, cert.tbs, issuer.modulus);
  }
  throw unsupported('unsupported certificate signature algorithm');
}

/** The leaf's P-384 key, once `x5c` is proven to chain to the pinned root. */
function verifiedLeafKey(x5c: string[], root: NrasCertificate, now: Date): Uint8Array {
  if (x5c.length !== 2) throw unsupported('expected a leaf and an intermediate certificate');
  const [leaf, intermediate] = x5c.map(cert => parseNrasCertificate(base64ToBytes(cert)));
  // The intermediate first: its key means nothing until the root has signed it.
  if (!signedBy(intermediate, root.key)) {
    throw unsupported('the intermediate does not chain to the pinned root');
  }
  if (!signedBy(leaf, intermediate.key)) {
    throw unsupported('the leaf does not chain to its intermediate');
  }
  for (const cert of [root, intermediate, leaf]) {
    if (now < cert.notBefore || now > cert.notAfter) {
      throw unsupported('a certificate is outside its validity window');
    }
  }
  if (leaf.key.kind !== 'p384') throw unsupported('the leaf key is not P-384');
  return leaf.key.point;
}

function base64UrlToBytes(part: string): Uint8Array {
  return base64ToBytes(part.replace(/-/g, '+').replace(/_/g, '/'));
}

function decodeTokenPart(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
}

/** The claims of a compact token, read only after its signature has verified. */
function verifiedClaims(
  token: string,
  keyFor: (kid: unknown) => Uint8Array,
): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw unsupported('a token is not a compact JWT');
  const [header, payload, signature] = parts;
  const { alg, kid } = decodeTokenPart(header);
  // Pinned before anything else: until the signature passes, the header is
  // whatever the gateway wrote.
  if (alg !== 'ES384') throw unsupported('unexpected token algorithm');
  const message = new TextEncoder().encode(`${header}.${payload}`);
  if (!verifyP384(base64UrlToBytes(signature), message, keyFor(kid))) {
    throw rejected('a token signature did not verify');
  }
  return decodeTokenPart(payload);
}

function expectClaim(claims: Record<string, unknown>, name: string, want: string | boolean): void {
  if (claims[name] !== want) throw rejected(`${name} is not the required value`);
}

/** Ties a token to this request. Never read this as the GPU having seen the
 *  nonce: that is the verdict claims (file header). */
function expectThisRequest(claims: Record<string, unknown>, nonce: string, now: Date): void {
  expectClaim(claims, 'eat_nonce', nonce);
  const { nbf, exp } = claims;
  if (typeof nbf !== 'number' || typeof exp !== 'number') {
    throw rejected('a token has no time window');
  }
  const seconds = now.getTime() / 1000;
  if (seconds < nbf - NRAS_CLOCK_LEEWAY_S || seconds > exp + NRAS_CLOCK_LEEWAY_S) {
    throw unsupported('a token is outside its time window');
  }
}

// Any shape this does not expect throws, and verifyNvidiaAttestation's catch
// reads that as not-checked, so a shape needs no check of its own here.
function checkNvidiaAttestation(
  raw: unknown,
  nonce: string,
  now: Date,
  root: NrasCertificate,
): { status: CheckStatus; detail: string } {
  const { tokens, keys } = raw as {
    tokens: [[string, string], Record<string, string>];
    keys: { kid: string; x5c: string[] }[];
  };
  const [[kind, overall], gpuRecord] = tokens;
  if (kind !== 'JWT') throw unsupported('unexpected token type');
  // Maps, so a name like `__proto__` reads as absent, and only own keys count.
  const gpuTokens = new Map(Object.entries(gpuRecord));
  if (gpuTokens.size > MAX_GPU_TOKENS) throw unsupported('more GPU tokens than this build reads');
  if (keys.length > MAX_NRAS_KEYS) throw unsupported('more keys than this build reads');

  const chains = new Map<unknown, string[]>();
  for (const { kid, x5c } of keys) {
    if (chains.has(kid)) throw unsupported('a key id appears twice');
    chains.set(kid, x5c);
  }
  const verifiedKeys = new Map<unknown, Uint8Array>();
  const keyFor = (kid: unknown): Uint8Array => {
    const known = verifiedKeys.get(kid);
    if (known) return known;
    const x5c = chains.get(kid);
    if (!x5c) throw unsupported('a token has no matching key');
    const key = verifiedLeafKey(x5c, root, now);
    verifiedKeys.set(kid, key);
    return key;
  };

  const top = verifiedClaims(overall, keyFor);
  expectClaim(top, 'iss', NRAS_ISSUER);
  expectThisRequest(top, nonce, now);
  expectClaim(top, 'x-nvidia-overall-att-result', true);

  const listed = new Map(Object.entries(top.submods as Record<string, unknown>));
  for (const name of [...listed.keys(), ...gpuTokens.keys()]) {
    // An NVSwitch token must not count as a GPU.
    if (!GPU_NAME.test(name)) throw unsupported('a token is not for a GPU');
  }
  if (listed.size === 0) throw unsupported('no GPU is listed');
  for (const name of gpuTokens.keys()) {
    if (!listed.has(name)) throw rejected(`${name} is not in the overall token`);
  }

  for (const [name, entry] of listed) {
    const token = gpuTokens.get(name);
    if (token === undefined) throw rejected(`${name} has no token`);
    const [, [digestAlgorithm, digest]] = entry as [unknown, [unknown, unknown]];
    if (digestAlgorithm !== 'SHA-256') throw unsupported('unexpected digest algorithm');
    const claims = verifiedClaims(token, keyFor);
    if (digest !== bytesToHex(sha256(new TextEncoder().encode(token)))) {
      throw rejected(`${name} does not match the overall token`);
    }
    expectThisRequest(claims, nonce, now);
    expectClaim(claims, 'x-nvidia-gpu-attestation-report-nonce-match', true);
    expectClaim(claims, 'x-nvidia-gpu-attestation-report-signature-verified', true);
    expectClaim(claims, 'measres', 'success');
    expectClaim(claims, 'secboot', true);
    expectClaim(claims, 'dbgstat', 'disabled');
  }
  return { status: 'pass', detail: `NVIDIA signed a passing result for ${listed.size} GPU(s)` };
}

/**
 * Check NVIDIA's signed result for one `nvidia_attestation` entry. Never throws.
 * `rootDer` exists so tests can sign with their own root; {@link verifyAttestation}
 * never passes it.
 */
export function verifyNvidiaAttestation(
  raw: unknown,
  expectedNonce: string | undefined,
  now: Date,
  rootDer: Uint8Array = base64ToBytes(NVIDIA_NRAS_ROOT_CA_DER_B64),
): { status: CheckStatus; detail: string } {
  try {
    if (!expectedNonce) throw unsupported('no client nonce to compare');
    return checkNvidiaAttestation(raw, expectedNonce, now, parseNrasCertificate(rootDer));
  } catch (e) {
    if (e instanceof NvidiaCheckStop) return { status: e.status, detail: e.message };
    // A fixed line: a parser's own message can quote the token.
    return { status: 'not-checked', detail: 'the NVIDIA attestation has a shape this build does not read' };
  }
}

/**
 * Overall verdict from the WEAKEST implemented check.
 *
 * Any `fail` → failed. Otherwise, because TCB is always unchecked,
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
