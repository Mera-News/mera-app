// e2ee-crypto — the E2EE PRIMITIVES, importable from Node.
//
// WHY THIS IS SEPARATE. `e2ee-service.ts` imports `getJwtToken` (better-auth),
// `logger` (Sentry + RN AppState), `gatewayRateLimiter` and `INFERENCE_ENDPOINT`
// (expo-constants) at module scope, so anything that wants `encryptContent`
// drags all four in and cannot load outside React Native. Everything here is
// pure `@noble` plus its own helpers, so a Node harness can build and open a
// real envelope without a device.
//
// NOTHING MOVED BUT THE LOCATION. The curve code, the blob layouts and the algo
// guard are byte-identical to what shipped in `e2ee-service.ts`; this is the one
// area where a "while I am here" tidy is silent locally and surfaces only as a
// NEAR `400 Decryption failed` from another repo. `e2ee-service` re-exports
// every symbol below, so no call site changed.
//
// The ONE signature difference: `encryptContent` and `decryptContent` take an
// `endpoint` for the typed error's detail field, because the value they used to
// read (`ATTESTATION_API`) is derived from `INFERENCE_ENDPOINT` and is exactly
// the impurity this module exists to shed. `e2ee-service` passes it in thin
// wrappers, so Sentry still records the same value it always did.
//
// THE ALGO GUARD TRAVELS WITH THE PRIMITIVES, deliberately. MERA-APP-39 was a
// stale stored algo paired with a freshly attested key of the wrong curve
// throwing an untyped noble error at ENCRYPT time and re-driving a poller every
// ~7s. A Node caller that got the primitives without that guard would be able to
// reproduce it off-device, which is the opposite of useful.

import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';

const TAG = '[E2EE]';

/** Signing/encryption algorithm family, keyed off the attestation key length.
 *  32-byte model key → 'ed25519'; 64-byte secp256k1 key → 'ecdsa'. */
export type SigningAlgo = 'ed25519' | 'ecdsa';

/** Client secret length for BOTH families — Ed25519 seeds and secp256k1 scalars
 *  are each 32 bytes. A persisted key of any other length is corrupt. */
export const CLIENT_SECRET_LEN = 32;

/** The single place the key-length → curve mapping lives. Every path that pairs
 *  a model key with an algo must agree, or the wrong curve's primitive receives
 *  the key and throws an untyped noble error deep in the stack (see
 *  {@link ModelKeyAlgoMismatchError}). */
export function algoForKeyBytes(len: number): SigningAlgo {
  if (len === 32) return 'ed25519';
  if (len === 64) return 'ecdsa';
  throw new Error(
    `NEAR attestation: unsupported signing-key length ${len} (expected 32 Ed25519 or 64 secp256k1)`,
  );
}

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

export function bytesToHex(b: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, '0');
  return hex;
}
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('Invalid hex string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface ModelKeyValidationDetails {
  keyHex: string;
  algo: SigningAlgo;
  model: string;
  endpoint: string;
  cause?: unknown;
}

/**
 * Thrown when the model's attestation key cannot be used for E2EE — currently a
 * 64-byte ecdsa key that is NOT a valid raw secp256k1 (x, y) point. NEAR's fleet
 * occasionally attests a same-length key that is not on the secp256k1 curve; the
 * legacy path only discovered this deep inside noble's `getSharedSecret` at
 * ENCRYPT time ("bad point: is not on curve"), which was uncaught at submit and
 * re-drove the scoring poller every ~7s (MERA-APP-39, 60 events). Detecting it
 * at attestation-fetch time and surfacing a TYPED error lets the caller
 * terminate the affected batch/run instead of looping.
 */
export class ModelKeyValidationError extends Error {
  readonly keyHex: string;
  readonly algo: SigningAlgo;
  readonly model: string;
  readonly endpoint: string;
  constructor(message: string, details: ModelKeyValidationDetails) {
    super(message);
    this.name = 'ModelKeyValidationError';
    this.keyHex = details.keyHex;
    this.algo = details.algo;
    this.model = details.model;
    this.endpoint = details.endpoint;
    if (details.cause !== undefined) {
      (this as { cause?: unknown }).cause = details.cause;
    }
    // Preserve instanceof across the TS/Babel transpile of `extends Error`.
    Object.setPrototypeOf(this, ModelKeyValidationError.prototype);
  }
}

/**
 * Thrown when a model key and the algo it is paired with disagree — the model
 * key is 64-byte secp256k1 but the context says 'ed25519', or vice versa.
 *
 * This is the root cause of MERA-APP-39. `rebuildE2EEContext` used to warn and
 * keep the STORED algo while adopting the FRESHLY-ATTESTED model key; since
 * NEAR's fleet load-balances curves and the attestation cache only lives 30
 * minutes, a run persisted under ed25519 could be rebuilt against a 64-byte
 * ecdsa key. `encryptEd25519` then fed 64 bytes to `ed25519.utils.toMontgomery`
 * and threw an UNTYPED `"point" expected Uint8Array of length 32, got
 * length=64` — at ENCRYPT time, before any POST, which the old comment here did
 * not anticipate (it assumed a divergence would surface at decrypt). Nothing
 * caught it, so it re-drove the scoring poller every ~7s and the run never
 * terminated, which in turn made every feed-sync cycle a no-op for up to 30
 * minutes at a stretch.
 *
 * Subclassing ModelKeyValidationError is deliberate: the existing terminal
 * handlers in scoring-pipeline already catch that type, so a mismatch now fails
 * the affected batch/run instead of looping, with no call-site changes.
 */
export class ModelKeyAlgoMismatchError extends ModelKeyValidationError {
  constructor(message: string, details: ModelKeyValidationDetails) {
    super(message, details);
    this.name = 'ModelKeyAlgoMismatchError';
    // Re-set after super(): the base ctor pins the prototype to its own.
    Object.setPrototypeOf(this, ModelKeyAlgoMismatchError.prototype);
  }
}


/**
 * The request headers for one E2EE context.
 *
 * Extracted because the rule in the last line was written TWICE, in
 * `prepareE2EEContext` and `rebuildE2EEContext`, and it is the rule that fails
 * silently: the version header is present for ed25519 and ABSENT for ecdsa, and
 * getting it wrong is not rejected by the gateway (a pure proxy) but by NEAR,
 * as a `400` carrying `Decryption failed`. Two copies of a rule whose breakage
 * surfaces in another repo is a drift risk, not a style preference.
 */
export function buildE2EEHeaders(
  algo: SigningAlgo,
  clientPubKeyHex: string,
  modelPubKeyHex: string,
): E2EEHeaders {
  return {
    'X-Signing-Algo': algo,
    'X-Client-Pub-Key': clientPubKeyHex,
    'X-Model-Pub-Key': modelPubKeyHex,
    ...(algo === 'ecdsa' ? {} : { 'X-Encryption-Version': ENCRYPTION_VERSION }),
  };
}

export function encryptContent(
  plaintext: string,
  ctx: E2EEContext,
  endpoint = '',
): string {
  // Last line of defence before the raw curve primitives. Any path that builds
  // a context pairing a key with the wrong algo fails HERE, typed and
  // attributable, rather than as an untyped noble error several frames deeper
  // (MERA-APP-39). `rebuildE2EEContext` is the path that used to do this, but
  // the assertion is cheap and covers callers not yet written.
  const keyAlgo = algoForKeyBytes(hexToBytes(ctx.modelPubKeyHex).length);
  if (keyAlgo !== ctx.algo) {
    throw new ModelKeyAlgoMismatchError(
      `${TAG} encryptContent: model key is ${keyAlgo} but context algo is ${ctx.algo}`,
      {
        keyHex: ctx.modelPubKeyHex,
        algo: ctx.algo,
        model: '(unknown)',
        endpoint,
      },
    );
  }
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
  endpoint = '',
): string {
  // Both curves use a 32-byte client secret; anything else is a corrupt or
  // truncated persisted key and would otherwise throw untyped inside noble.
  if (privateKey.length !== CLIENT_SECRET_LEN) {
    throw new ModelKeyAlgoMismatchError(
      `${TAG} decryptContent: client secret is ${privateKey.length} bytes, expected ${CLIENT_SECRET_LEN} (algo=${algo})`,
      { keyHex: '', algo, model: '(unknown)', endpoint },
    );
  }
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
