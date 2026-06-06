/** NEAR AI Cloud v2 E2EE: X25519 ECDH + HKDF-SHA256 + XChaCha20-Poly1305.
 *
 *  Client identity is Ed25519 (what the server sees in X-Client-Pub-Key).
 *  Request encryption uses an ephemeral X25519 key pair. Response decryption
 *  uses the X25519 secret derived from the client's Ed25519 secret — the
 *  server encrypts responses toward the client's converted X25519 pubkey.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';

import { getJwtToken } from '../auth-client';
import logger from '../logger';
import { withRetry } from '../utils/retry';
import { getCachedAttestation, setCachedAttestation } from './e2ee-cache';
import { INFERENCE_ENDPOINT } from '@/lib/config/endpoints';

const TAG = '[E2EE]';
const HKDF_INFO = new TextEncoder().encode('ed25519_encryption');

// Backend contract (not an app-side config): the inference backend behind
// EXPO_PUBLIC_INFERENCE_ENDPOINT must implement the NEAR AI Cloud v2
// attestation route (GET/POST /api/attestation/report returning a
// ModelAttestation with an Ed25519 model pubkey). A forker pointing this at a
// generic OpenAI-compatible server will get 404s here, breaking cloud E2EE
// inference.
const ATTESTATION_API = `${INFERENCE_ENDPOINT}/api/attestation/report`;

export interface ModelAttestation {
  /** Hex-encoded Ed25519 model pubkey. */
  publicKey: string;
  /** Optional identity stamp — NEAR AI signing address. */
  signingId?: string;
}

export interface E2EEHeaders {
  'X-Signing-Algo': string;
  'X-Client-Pub-Key': string;
  'X-Model-Pub-Key': string;
  'X-Encryption-Version': string;
}

/** Per-request crypto state. `privateKey` is the client's Ed25519 secret —
 *  needed at response-decryption time. Kept as bytes for in-flight use;
 *  serialized to hex for durable storage. */
export interface E2EEContext {
  modelPubKeyHex: string;
  privateKey: Uint8Array;
  clientPubKeyHex: string;
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
  if (hexToBytes(pub).length !== 32) {
    throw new Error(`NEAR attestation: expected 32-byte Ed25519 pubkey, got ${pub.length / 2}`);
  }
  const attestation: ModelAttestation = {
    publicKey: pub,
    signingId: (mas?.[0]?.signing_address as string | undefined) ?? undefined,
  };
  setCachedAttestation(model, attestation);
  return attestation;
}

export async function prepareE2EEContext(model: string): Promise<E2EEContext> {
  const attestation = await fetchModelPublicKey(model);

  // Client identity is Ed25519. Server sees this pubkey in X-Client-Pub-Key
  // and encrypts the response toward the Montgomery form of it.
  const edSecret = ed25519.utils.randomSecretKey();
  const edPublic = ed25519.getPublicKey(edSecret);
  const clientPubKeyHex = bytesToHex(edPublic);

  const headers: E2EEHeaders = {
    'X-Signing-Algo': 'ed25519',
    'X-Client-Pub-Key': clientPubKeyHex,
    'X-Model-Pub-Key': attestation.publicKey,
    'X-Encryption-Version': '2',
  };

  return {
    modelPubKeyHex: attestation.publicKey,
    privateKey: edSecret,
    clientPubKeyHex,
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
  // Model's Ed25519 pubkey → X25519 pubkey
  const modelX25519Pub = ed25519.utils.toMontgomery(hexToBytes(ctx.modelPubKeyHex));

  // Ephemeral X25519 key pair for this message
  const ephSecret = randomBytes(32);
  const ephPublic = x25519.getPublicKey(ephSecret);

  // ECDH + HKDF
  const shared = x25519.getSharedSecret(ephSecret, modelX25519Pub);
  const key = hkdf(sha256, shared, undefined, HKDF_INFO, 32);

  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(plaintext));

  const blob = new Uint8Array(32 + 24 + ct.length);
  blob.set(ephPublic, 0);
  blob.set(nonce, 32);
  blob.set(ct, 56);
  return bytesToHex(blob);
}

export function decryptContent(hexBlob: string, edPrivateKey: Uint8Array): string {
  const blob = hexToBytes(hexBlob);
  if (blob.length < 57) {
    throw new Error(`NEAR decrypt: blob too short (${blob.length} bytes)`);
  }
  const ephPub = blob.slice(0, 32);
  const nonce = blob.slice(32, 56);
  const ct = blob.slice(56);

  // Our Ed25519 secret → X25519 secret, then ECDH with server's ephemeral
  // X25519 pubkey from the blob.
  const xSecret = ed25519.utils.toMontgomerySecret(edPrivateKey);
  const shared = x25519.getSharedSecret(xSecret, ephPub);
  const key = hkdf(sha256, shared, undefined, HKDF_INFO, 32);

  const plaintext = xchacha20poly1305(key, nonce).decrypt(ct);
  return new TextDecoder().decode(plaintext);
}
