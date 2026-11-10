// The mock's two crypto directions, both through the app's own primitives
// (lib/e2ee/e2ee-crypto.ts). Nothing is reimplemented here, except the v2 model side below,
// which the spec defines and the app has no reason to carry.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { realKeyVerifier, setKeyVerifier } from '../../../lib/e2ee/key-verifier';
import {
  bytesToHex,
  decryptContent,
  encryptContent,
  hexToBytes,
  V2_ALGO,
  v2Aad,
  type E2EEContext,
  type E2EEV2Params,
} from '../../../lib/e2ee/e2ee-crypto';
import { TEST_MODEL_KEYS, type GatewayAlgo } from './keys';

/** Open a client -> model envelope with the test model's secret. Throws when it does not open. */
export function openFromClient(blobHex: string, algo: GatewayAlgo): string {
  return decryptContent(blobHex, TEST_MODEL_KEYS[algo].secret, algo);
}

/**
 * Seal model -> client text toward the `X-Client-Pub-Key` header value.
 * encryptContent mints a fresh ephemeral key on every call, so each SSE chunk
 * is its own envelope, as NEAR's are.
 */
export function sealForClient(plaintext: string, clientPubHeaderHex: string, algo: GatewayAlgo): string {
  // The ecdsa header is the 65-byte uncompressed point (0x04 || x || y);
  // encryptContent takes the 64-byte raw key and algoForKeyBytes throws on 65.
  const raw = hexToBytes(clientPubHeaderHex);
  const key = algo === 'ecdsa' && raw.length === 65 && raw[0] === 0x04 ? raw.slice(1) : raw;
  // Only modelPubKeyHex and algo are read on the encrypt side.
  const ctx = {
    modelPubKeyHex: bytesToHex(key),
    algo,
    privateKey: new Uint8Array(32),
    clientPubKeyHex: '',
    headers: {},
  } as unknown as E2EEContext;
  return encryptContent(plaintext, ctx);
}

// --- RedPill E2EE v2 and hot-path verification --------------------------------------------


// The mock's test keys have no Intel quote, so the hot-path check would refuse them. Accept
// exactly those keys (raw, 0x or 04 form) and hand every other key to the real verifier, so a
// fixture or tampered key in any test is still judged for real. Installed on import: every
// suite that reaches the mock gateway imports this file through handlers.ts.
const testKeys = new Set(Object.values(TEST_MODEL_KEYS).map(k => k.publicKeyHex));
setKeyVerifier(input => {
  const k = input.signingPublicKey.replace(/^0x/, '').toLowerCase();
  if (testKeys.has(k) || (k.length === 130 && testKeys.has(k.slice(2)))) return [];
  return realKeyVerifier(input);
});

const V2_INFO = new TextEncoder().encode('aci.e2ee.v2.secp256k1');
const v2Key = (secret: Uint8Array, peer65: Uint8Array) =>
  hkdf(sha256, secp256k1.getSharedSecret(secret, peer65).slice(1, 33), undefined, V2_INFO, 32);

/** A RedPill-shaped attestation body serving the mock's ecdsa test key (no quote). */
export function redpillAttestationBody(): Record<string, unknown> {
  const key65 = `04${TEST_MODEL_KEYS.ecdsa.publicKeyHex}`;
  return {
    api_version: 'aci/1',
    attestation: { workload_keyset: { e2ee_public_keys: [{ key_id: 'dstack-kms-e2ee-v1', algo: V2_ALGO, public_key: key65 }] } },
    service_capabilities: { supported_e2ee_versions: ['2'] },
    signing_public_key: key65,
    signing_algo: 'ecdsa',
  };
}

/** Open a v2 request field with the test model's secret (throws when the AAD does not match). */
export function openFromClientV2(blobHex: string, p: E2EEV2Params, field: string): string {
  const b = hexToBytes(blobHex);
  const key = v2Key(TEST_MODEL_KEYS.ecdsa.secret, b.slice(0, 65));
  return new TextDecoder().decode(gcm(key, b.slice(65, 77), v2Aad(V2_ALGO, p, field)).decrypt(b.slice(77)));
}

/** Seal a v2 response field toward the `X-Client-Pub-Key` value (65-byte point). */
export function sealForClientV2(plaintext: string, clientPubHex: string, p: E2EEV2Params, field: string, id: string): string {
  const eph = secp256k1.utils.randomSecretKey();
  const iv = randomBytes(12);
  const ct = gcm(v2Key(eph, hexToBytes(clientPubHex)), iv, v2Aad(V2_ALGO, p, field, id)).encrypt(new TextEncoder().encode(plaintext));
  return bytesToHex(secp256k1.getPublicKey(eph, false)) + bytesToHex(iv) + bytesToHex(ct);
}
