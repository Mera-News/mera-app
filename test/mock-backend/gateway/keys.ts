// Fixed test keys for the mocked model. The mock stands in for NEAR: it serves
// the PUBLIC half on the attestation route and opens client envelopes with the
// SECRET half. Seeds are constants so a failing run reproduces byte for byte.
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '../../../lib/e2ee/e2ee-crypto';

export type GatewayAlgo = 'ed25519' | 'ecdsa';

const ED_SECRET = new Uint8Array(32).fill(0x11);
const EC_SECRET = new Uint8Array(32).fill(0x22);

export const TEST_MODEL_KEYS: Record<GatewayAlgo, { secret: Uint8Array; publicKeyHex: string }> = {
  ed25519: { secret: ED_SECRET, publicKeyHex: bytesToHex(ed25519.getPublicKey(ED_SECRET)) },
  // The attestation key is the raw 64-byte x||y; getPublicKey(.., false) is 0x04||x||y.
  ecdsa: {
    secret: EC_SECRET,
    publicKeyHex: bytesToHex(secp256k1.getPublicKey(EC_SECRET, false).slice(1)),
  },
};
