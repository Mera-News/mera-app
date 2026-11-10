// The hot-path key check (route1 P6), in its own pure module so the mock gateway can swap it
// without importing e2ee-service: that file pulls better-auth in, and the integration setup
// loads the mock before msw patches fetch.
import {
  hotPathFailures,
  verifyAttestation,
  type AttestationInput,
  type CheckResult,
} from '../algorithms/attestation-verify';

/** Decides whether a served key may be used: the failing checks, empty to pass. */
export type KeyVerifier = (input: AttestationInput) => CheckResult[];

export const realKeyVerifier: KeyVerifier = input => hotPathFailures(verifyAttestation(input));
let current: KeyVerifier = realKeyVerifier;

export const verifyKey: KeyVerifier = input => current(input);

/**
 * Swap the verifier; no argument restores the real one. Exists for the mock gateway, whose test
 * keys carry no Intel quote (test/mock-backend/gateway/crypto.ts accepts exactly those keys and
 * hands every other key to the real verifier). Production never calls it.
 */
export function setKeyVerifier(next?: KeyVerifier): void {
  current = next ?? realKeyVerifier;
}
