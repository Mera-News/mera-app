// The mock's two crypto directions, both through the app's own primitives
// (lib/e2ee/e2ee-crypto.ts). Nothing is reimplemented here.
import {
  bytesToHex,
  decryptContent,
  encryptContent,
  hexToBytes,
  type E2EEContext,
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
