// The E2EE entry points for one profile: the key fetch, the context and the sealed messages,
// each told which provider holds the model. The one place lib/llm hands a provider to lib/e2ee.
import {
  encryptMessages,
  fetchModelPublicKey,
  prepareE2EEContext,
  rebuildE2EEContext,
  type AttestationFetchOptions,
  type E2EEContext,
  type ModelAttestation,
  type SigningAlgo,
} from '../e2ee/e2ee-service';
import type { GatewayLane } from './gateway-rate-limiter';
import type { CloudPurpose } from './on-device-gate';
import type { Profile } from './profiles';

/** The header that tells the gateway which provider to proxy to. Absent means near (old builds). */
export const providerHeader = (profile: Profile): Record<string, string> => ({ 'X-Mera-Provider': profile.provider });

/** The attestation cache's key for `profile`. Mirrors lib/e2ee's own rule: NEAR keeps the bare model id. */
export const attestationCacheKey = (profile: Profile): string =>
  profile.provider === 'near' ? profile.model : `${profile.provider}:${profile.model}`;

export function attestProfile(
  profile: Profile,
  lane: GatewayLane = 'background',
  opts: AttestationFetchOptions = {},
): Promise<ModelAttestation> {
  return fetchModelPublicKey(profile.model, lane, opts, profile.provider);
}

export function prepareForProfile(
  profile: Profile,
  lane: GatewayLane = 'background',
  opts: AttestationFetchOptions = {},
  purpose?: CloudPurpose,
): Promise<E2EEContext> {
  return prepareE2EEContext(profile.model, lane, opts, purpose, profile.provider);
}

export function rebuildForProfile(
  profile: Profile,
  privKeyHex: string,
  algo: SigningAlgo,
  lane: GatewayLane = 'background',
  opts: AttestationFetchOptions = {},
): Promise<E2EEContext> {
  return rebuildE2EEContext(profile.model, privKeyHex, algo, lane, opts, profile.provider);
}

/** `encryptMessages` for one profile: fail-closed field checks, then every non-empty content sealed in place. */
export function sealMessages(
  messages: { role: string; content: string; [k: string]: unknown }[],
  profile: Profile,
  lane: GatewayLane = 'background',
  purpose?: CloudPurpose,
): Promise<E2EEContext> {
  return encryptMessages(messages, profile.model, lane, purpose, profile.provider);
}
