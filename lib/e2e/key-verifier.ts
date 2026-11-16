// lib/e2ee/key-verifier.ts for the device lane only: metro.config.js resolves e2ee-service's
// `./key-verifier` import here when EXPO_PUBLIC_E2E=1. The mock gateway serves its test keys with no
// Intel quote, so the real fail-closed check refused every key and no chat request was ever sent.
// Jest needs none of this: there the mock swaps the verifier in its own process (crypto.ts).
//
// Accepts exactly the mock's test keys, and only in E2E mode (flag AND loopback endpoints); every
// other key, and every key outside E2E mode, goes to the real verifier. The export below doubles
// as the bundle marker scripts/e2e-android.sh greps.
import { realKeyVerifier, setKeyVerifier, type KeyVerifier } from '../e2ee/key-verifier';
import { E2E_MODE } from '../e2e-mode';
import { TEST_MODEL_KEYS } from '../../test/mock-backend/gateway/keys';

export const E2E_KEY_VERIFIER_MARKER = 'e2e-key-verifier-test-keys';

const TEST_KEYS = new Set(Object.values(TEST_MODEL_KEYS).map(k => k.publicKeyHex.toLowerCase()));

function isTestKey(signingPublicKey: string): boolean {
  const k = signingPublicKey.replace(/^0x/i, '').toLowerCase();
  // ecdsa keys also arrive as the 65-byte 04||x||y point.
  return TEST_KEYS.has(k) || (k.length === 130 && k.startsWith('04') && TEST_KEYS.has(k.slice(2)));
}

export const verifyKey: KeyVerifier = input =>
  E2E_MODE && isTestKey(input.signingPublicKey) ? [] : realKeyVerifier(input);

export { realKeyVerifier, setKeyVerifier };
export type { KeyVerifier };
