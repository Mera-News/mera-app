/** NEAR AI Cloud v2 E2EE — algorithm-agnostic. The model's TEE attestation
 *  returns a signing pubkey in one of two families, and the app must encrypt
 *  toward whichever it gets (NEAR's fleet load-balances across both):
 *
 *   - ed25519 (32-byte key): Ed25519 identity → X25519 ECDH + HKDF-SHA256 +
 *     XChaCha20-Poly1305. Request encryption uses an ephemeral X25519 keypair;
 *     response decryption converts the client's Ed25519 secret to X25519.
 *   - ecdsa (64-byte secp256k1 key, raw x‖y): secp256k1 ECDH + HKDF-SHA256 +
 *     AES-256-GCM. secp256k1 is its own ECDH curve, so the client secret is
 *     used directly with no Montgomery conversion.
 *
 *  The algo is detected from the attestation key length (see
 *  fetchModelPublicKey) and threaded through the E2EEContext + persisted async
 *  jobs so response decryption picks the matching curve.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';

import { getJwtToken } from '../auth-client';
import logger from '../logger';
import { withRetry } from '../utils/retry';
import { getCachedAttestation, setCachedAttestation } from './e2ee-cache';
import { INFERENCE_ENDPOINT } from '@/lib/config/endpoints';

const TAG = '[E2EE]';

/** Signing/encryption algorithm family, keyed off the attestation key length.
 *  32-byte model key → 'ed25519'; 64-byte secp256k1 key → 'ecdsa'. */
export type SigningAlgo = 'ed25519' | 'ecdsa';

// ─── Per-algo wire constants ─────────────────────────────────────────────────
// The HKDF `info` string mirrors NEAR's `{algo}_encryption` convention — the
// working ed25519 path uses 'ed25519_encryption', so the ecdsa path uses
// 'ecdsa_encryption' (corroborated by the venice-e2ee reference, identical
// primitive stack). Each value below is isolated as a named constant so a
// single-line change corrects it if a live NEAR interop test disproves it.
const HKDF_INFO_ED25519 = new TextEncoder().encode('ed25519_encryption');
const HKDF_INFO_ECDSA = new TextEncoder().encode('ecdsa_encryption');

// ed25519 blob: ephX25519Pub(32) ‖ nonce(24) ‖ ct+tag
const ED25519_EPH_PUB_LEN = 32;
const ED25519_NONCE_LEN = 24;
// ecdsa blob: ephSecp256k1Pub(65, uncompressed 0x04) ‖ iv(12) ‖ ct+tag
const ECDSA_EPH_PUB_LEN = 65;
const ECDSA_IV_LEN = 12;
const GCM_TAG_LEN = 16;

/** Envelope version sent in X-Encryption-Version; '2' for both algo families. */
const ENCRYPTION_VERSION = '2';

// Backend contract (not an app-side config): the inference backend behind
// EXPO_PUBLIC_INFERENCE_ENDPOINT must implement the NEAR AI Cloud v2
// attestation route (GET/POST /api/attestation/report returning a
// ModelAttestation with an Ed25519 model pubkey). A forker pointing this at a
// generic OpenAI-compatible server will get 404s here, breaking cloud E2EE
// inference.
const ATTESTATION_API = `${INFERENCE_ENDPOINT}/api/attestation/report`;

export interface ModelAttestation {
  /** Hex-encoded model pubkey: 32-byte Ed25519 or 64-byte secp256k1 (raw x‖y). */
  publicKey: string;
  /** Which curve `publicKey` is, detected from its byte length. */
  algo: SigningAlgo;
  /** Optional identity stamp — NEAR AI signing address. */
  signingId?: string;
}

export interface E2EEHeaders {
  'X-Signing-Algo': string;
  'X-Client-Pub-Key': string;
  'X-Model-Pub-Key': string;
  /** Only the ed25519 v2 scheme is versioned; the legacy ecdsa scheme omits it. */
  'X-Encryption-Version'?: string;
}

/** Per-request crypto state. `privateKey` is the client's secret (Ed25519 or
 *  secp256k1, both 32 bytes) — needed at response-decryption time. Kept as
 *  bytes for in-flight use; serialized to hex for durable storage. `algo` must
 *  travel with the key so decryption picks the matching curve. */
export interface E2EEContext {
  modelPubKeyHex: string;
  privateKey: Uint8Array;
  clientPubKeyHex: string;
  algo: SigningAlgo;
  headers: E2EEHeaders;
}

function fetchWithTimeout(
  url: string,
  opts: RequestInit,
  ms = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

function bytesToHex(b: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, '0');
  return hex;
}
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('Invalid hex string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function fetchModelPublicKey(model: string): Promise<ModelAttestation> {
  const cached = getCachedAttestation(model);
  if (cached) return cached;

  // Dev-only timing: this is the uncached NEAR pass-through — the dominant
  // first-chat-latency hop we prewarm against. Cache hits above never reach here.
  const attestStartMs = Date.now();
  const token = await getJwtToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const url =
    `${ATTESTATION_API}?model=${encodeURIComponent(model)}&signing_algo=ed25519`;

  const res = await withRetry(
    async () => {
      const r = await fetchWithTimeout(url, { headers });
      if (r.status >= 500) {
        const body = await r.text().catch(() => '');
        throw new Error(`NEAR attestation failed (${r.status}): ${body.slice(0, 200)}`);
      }
      return r;
    },
    undefined,
    5,
    TAG,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`NEAR attestation failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const mas = data.model_attestations as Record<string, unknown>[] | undefined;
  const pub = mas?.[0]?.signing_public_key as string | undefined;
  if (!pub) {
    throw new Error(
      `NEAR attestation: signing_public_key missing. top=${Object.keys(data).join(',')}`,
    );
  }
  // Detect the algo from the returned key length rather than asserting a single
  // curve: NEAR's TEE fleet returns either a 32-byte Ed25519 or a 64-byte
  // secp256k1 key (we request ed25519 as a preference, but the param is only
  // advisory — the node returns whatever key it attests).
  const keyLen = hexToBytes(pub).length;
  let algo: SigningAlgo;
  if (keyLen === 32) {
    algo = 'ed25519';
  } else if (keyLen === 64) {
    algo = 'ecdsa';
  } else {
    throw new Error(
      `NEAR attestation: unsupported signing-key length ${keyLen} (expected 32 Ed25519 or 64 secp256k1)`,
    );
  }
  const attestation: ModelAttestation = {
    publicKey: pub,
    algo,
    signingId: (mas?.[0]?.signing_address as string | undefined) ?? undefined,
  };
  setCachedAttestation(model, attestation);
  logger.debug('[chat-timing] attestation fetch', {
    ms: Date.now() - attestStartMs,
    model,
    algo,
    cache: 'miss',
  });
  return attestation;
}

export async function prepareE2EEContext(model: string): Promise<E2EEContext> {
  const attestation = await fetchModelPublicKey(model);
  const { algo } = attestation;

  // Generate the client keypair on the algo's own curve. The server sees the
  // public half in X-Client-Pub-Key and encrypts responses toward it; the
  // secret half is retained to decrypt them.
  let privateKey: Uint8Array;
  let clientPubKeyHex: string;
  if (algo === 'ecdsa') {
    // secp256k1: header carries the FULL 65-byte uncompressed point (0x04 ‖ x ‖ y)
    // — NEAR's X962 UncompressedPoint encoding for X-Client-Pub-Key. (Note the
    // asymmetry: the *model's* attestation key is the 64-byte raw x‖y; the
    // *client* header keeps the 0x04 prefix.)
    privateKey = secp256k1.utils.randomSecretKey();
    clientPubKeyHex = bytesToHex(secp256k1.getPublicKey(privateKey, false));
  } else {
    privateKey = ed25519.utils.randomSecretKey();
    clientPubKeyHex = bytesToHex(ed25519.getPublicKey(privateKey));
  }

  const headers: E2EEHeaders = {
    'X-Signing-Algo': algo,
    'X-Client-Pub-Key': clientPubKeyHex,
    'X-Model-Pub-Key': attestation.publicKey,
    // X-Encryption-Version '2' identifies the ed25519 v2 scheme. The legacy
    // ecdsa scheme is unversioned — NEAR's documented ecdsa request omits the
    // header, so we do too (sending '2' with ecdsa could misroute to the v2
    // decryptor).
    ...(algo === 'ecdsa' ? {} : { 'X-Encryption-Version': ENCRYPTION_VERSION }),
  };

  return {
    modelPubKeyHex: attestation.publicKey,
    privateKey,
    clientPubKeyHex,
    algo,
    headers,
  };
}

/**
 * Rebuild an E2EEContext from a previously-minted private key so that multiple
 * gateway submits across a long-lived run can share ONE keypair (the scoring
 * pipeline mints a keypair at run creation and replays it on every batch
 * submit). Unlike `prepareE2EEContext` — which generates a fresh keypair each
 * call — this derives the client public half from the stored secret so the
 * server encrypts responses toward the same key the run can later decrypt with.
 *
 * The model public key is re-fetched from the (cached) attestation; the stored
 * `algo` governs the client-key curve. If the freshly-attested algo diverges
 * from the stored one (NEAR fleet load-balances curves) we keep the stored algo
 * — the keypair is bound to it — and log; a genuine divergence would fail the
 * run's decrypt and the rows simply re-enter the next run.
 */
export async function rebuildE2EEContext(
  model: string,
  privKeyHex: string,
  algo: SigningAlgo,
): Promise<E2EEContext> {
  const attestation = await fetchModelPublicKey(model);
  if (attestation.algo !== algo) {
    logger.warn(
      `${TAG} rebuildE2EEContext: attested algo ${attestation.algo} != stored ${algo}; keeping stored`,
    );
  }
  const privateKey = hexToBytes(privKeyHex);
  const clientPubKeyHex =
    algo === 'ecdsa'
      ? bytesToHex(secp256k1.getPublicKey(privateKey, false))
      : bytesToHex(ed25519.getPublicKey(privateKey));

  const headers: E2EEHeaders = {
    'X-Signing-Algo': algo,
    'X-Client-Pub-Key': clientPubKeyHex,
    'X-Model-Pub-Key': attestation.publicKey,
    ...(algo === 'ecdsa' ? {} : { 'X-Encryption-Version': ENCRYPTION_VERSION }),
  };

  return {
    modelPubKeyHex: attestation.publicKey,
    privateKey,
    clientPubKeyHex,
    algo,
    headers,
  };
}

/** Encrypt every non-empty string `content` in-place and return the context. */
export async function encryptMessages(
  messages: { role: string; content: string;[k: string]: unknown }[],
  model: string,
): Promise<E2EEContext> {
  const ctx = await prepareE2EEContext(model);
  for (const msg of messages) {
    if (typeof msg.content !== 'string' || msg.content.length === 0) continue;
    msg.content = encryptContent(msg.content, ctx);
  }
  return ctx;
}

export function encryptContent(plaintext: string, ctx: E2EEContext): string {
  return ctx.algo === 'ecdsa'
    ? encryptEcdsa(plaintext, ctx.modelPubKeyHex)
    : encryptEd25519(plaintext, ctx.modelPubKeyHex);
}

/** Decrypt a server→client blob. `algo` MUST match the context the request was
 *  encrypted under (persisted alongside the key for the async path). Defaults
 *  to 'ed25519' so legacy callers and jobs written before the ecdsa split keep
 *  working. */
export function decryptContent(
  hexBlob: string,
  privateKey: Uint8Array,
  algo: SigningAlgo = 'ed25519',
): string {
  return algo === 'ecdsa'
    ? decryptEcdsa(hexBlob, privateKey)
    : decryptEd25519(hexBlob, privateKey);
}

// ─── ed25519: X25519 ECDH + XChaCha20-Poly1305 ───────────────────────────────

function encryptEd25519(plaintext: string, modelPubKeyHex: string): string {
  // Model's Ed25519 pubkey → X25519 pubkey
  const modelX25519Pub = ed25519.utils.toMontgomery(hexToBytes(modelPubKeyHex));

  // Ephemeral X25519 key pair for this message
  const ephSecret = randomBytes(32);
  const ephPublic = x25519.getPublicKey(ephSecret);

  // ECDH + HKDF
  const shared = x25519.getSharedSecret(ephSecret, modelX25519Pub);
  const key = hkdf(sha256, shared, undefined, HKDF_INFO_ED25519, 32);

  const nonce = randomBytes(ED25519_NONCE_LEN);
  const ct = xchacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(plaintext));

  const blob = new Uint8Array(ED25519_EPH_PUB_LEN + ED25519_NONCE_LEN + ct.length);
  blob.set(ephPublic, 0);
  blob.set(nonce, ED25519_EPH_PUB_LEN);
  blob.set(ct, ED25519_EPH_PUB_LEN + ED25519_NONCE_LEN);
  return bytesToHex(blob);
}

function decryptEd25519(hexBlob: string, edPrivateKey: Uint8Array): string {
  const blob = hexToBytes(hexBlob);
  const headerLen = ED25519_EPH_PUB_LEN + ED25519_NONCE_LEN;
  if (blob.length < headerLen + 1) {
    throw new Error(`NEAR decrypt: blob too short (${blob.length} bytes)`);
  }
  const ephPub = blob.slice(0, ED25519_EPH_PUB_LEN);
  const nonce = blob.slice(ED25519_EPH_PUB_LEN, headerLen);
  const ct = blob.slice(headerLen);

  // Our Ed25519 secret → X25519 secret, then ECDH with server's ephemeral
  // X25519 pubkey from the blob.
  const xSecret = ed25519.utils.toMontgomerySecret(edPrivateKey);
  const shared = x25519.getSharedSecret(xSecret, ephPub);
  const key = hkdf(sha256, shared, undefined, HKDF_INFO_ED25519, 32);

  const plaintext = xchacha20poly1305(key, nonce).decrypt(ct);
  return new TextDecoder().decode(plaintext);
}

// ─── ecdsa: secp256k1 ECDH + AES-256-GCM ─────────────────────────────────────
// secp256k1 signs and does ECDH on the same curve, so the client secret is used
// directly (no Ed25519→Montgomery conversion). The 32-byte x-coordinate of the
// shared point feeds HKDF. Blob: ephPub(65, uncompressed) ‖ iv(12) ‖ ct+tag.

/** ECDH → HKDF-SHA256 → AES-256 key for the shared point between `secret` and
 *  the 65-byte uncompressed `peerPub65`. */
function deriveEcdsaKey(secret: Uint8Array, peerPub65: Uint8Array): Uint8Array {
  const sharedPoint = secp256k1.getSharedSecret(secret, peerPub65);
  const x = sharedPoint.slice(1, 33); // 32-byte x-coordinate
  return hkdf(sha256, x, undefined, HKDF_INFO_ECDSA, 32);
}

function encryptEcdsa(plaintext: string, modelPubKeyHex: string): string {
  // 64-byte raw x‖y attestation key → 65-byte uncompressed point (0x04 ‖ x ‖ y).
  const modelPub65 = new Uint8Array(65);
  modelPub65[0] = 0x04;
  modelPub65.set(hexToBytes(modelPubKeyHex), 1);

  const ephSecret = secp256k1.utils.randomSecretKey();
  const ephPublic = secp256k1.getPublicKey(ephSecret, false); // 65-byte uncompressed
  const key = deriveEcdsaKey(ephSecret, modelPub65);

  const iv = randomBytes(ECDSA_IV_LEN);
  const ct = gcm(key, iv).encrypt(new TextEncoder().encode(plaintext)); // tag appended

  const blob = new Uint8Array(ECDSA_EPH_PUB_LEN + ECDSA_IV_LEN + ct.length);
  blob.set(ephPublic, 0);
  blob.set(iv, ECDSA_EPH_PUB_LEN);
  blob.set(ct, ECDSA_EPH_PUB_LEN + ECDSA_IV_LEN);
  return bytesToHex(blob);
}

function decryptEcdsa(hexBlob: string, privateKey: Uint8Array): string {
  const blob = hexToBytes(hexBlob);
  const headerLen = ECDSA_EPH_PUB_LEN + ECDSA_IV_LEN;
  if (blob.length < headerLen + GCM_TAG_LEN) {
    throw new Error(`NEAR decrypt: ecdsa blob too short (${blob.length} bytes)`);
  }
  const ephPub = blob.slice(0, ECDSA_EPH_PUB_LEN);
  const iv = blob.slice(ECDSA_EPH_PUB_LEN, headerLen);
  const ct = blob.slice(headerLen);

  const key = deriveEcdsaKey(privateKey, ephPub);
  const plaintext = gcm(key, iv).decrypt(ct);
  return new TextDecoder().decode(plaintext);
}
