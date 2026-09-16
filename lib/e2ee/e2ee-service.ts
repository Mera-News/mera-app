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
import * as gatewayRateLimiter from '../llm/gateway-rate-limiter';
import { getCachedAttestation, setCachedAttestation } from './e2ee-cache';
import { INFERENCE_ENDPOINT } from '@/lib/config/endpoints';
import {
  algoForKeyBytes,
  buildE2EEHeaders,
  bytesToHex,
  CLIENT_SECRET_LEN,
  encryptContent as encryptContentPure,
  decryptContent as decryptContentPure,
  hexToBytes,
  ModelKeyAlgoMismatchError,
  ModelKeyValidationError,
  type E2EEContext,
  type E2EEHeaders,
  type ModelKeyValidationDetails,
  type SigningAlgo,
} from './e2ee-crypto';

// Re-exported so every existing import site keeps working unchanged. The
// primitives moved OUT of this file; nothing about what they do moved.
export {
  algoForKeyBytes,
  buildE2EEHeaders,
  ModelKeyAlgoMismatchError,
  ModelKeyValidationError,
};
export type { E2EEContext, E2EEHeaders, ModelKeyValidationDetails, SigningAlgo };

/**
 * `encryptContent` / `decryptContent` with this module's attestation endpoint
 * bound in.
 *
 * The pure versions take `endpoint` for the typed error's detail field, because
 * ATTESTATION_API is derived from INFERENCE_ENDPOINT and is exactly the
 * expo-constants dependency e2ee-crypto exists to shed. Binding it here keeps
 * the value Sentry records identical to what it has always been, and keeps both
 * call signatures unchanged for every existing caller.
 */
export function encryptContent(plaintext: string, ctx: E2EEContext): string {
  return encryptContentPure(plaintext, ctx, ATTESTATION_API);
}
export function decryptContent(
  hexBlob: string,
  privateKey: Uint8Array,
  algo: SigningAlgo = 'ed25519',
): string {
  return decryptContentPure(hexBlob, privateKey, algo, ATTESTATION_API);
}


/**
 * A NEAR attestation HTTP failure, carrying the status as a FIELD rather than
 * only inside the message.
 *
 * `isUnauthenticatedError` (lib/utils/retry.ts) reads `statusCode` /
 * `response.status`; a plain `new Error("... (401): ...")` exposes neither, so
 * the app's 401 rule could not see these at all and a dead session reported a
 * second, separate Sentry issue from here (MERA-APP-18: 2726 events,
 * MERA-APP-23). The status is still interpolated into the message so existing
 * log readers and the e2ee tests that match /NEAR attestation failed \(403\)/
 * keep working.
 */
class NearAttestationError extends Error {
  readonly statusCode: number;
  constructor(status: number, body: string) {
    super(`NEAR attestation failed (${status}): ${body.slice(0, 200)}`);
    this.name = 'NearAttestationError';
    this.statusCode = status;
  }
}

/**
 * There is no credential to attest with, so no request was made.
 *
 * `/api/attestation/report` sits behind the gateway's AuthGuard, so a fetch with
 * no Authorization header is a GUARANTEED 401, not a maybe — and the header used
 * to be conditional (`if (token) headers[...] = ...`), which sent exactly that
 * request every time a background job ran before auth had settled. The weekly
 * sanity audit fires ~2s into a cold launch, which is how MERA-APP-16 reached 67
 * events: one user alone accounted for 41.
 *
 * A SEPARATE type from {@link NearAttestationError} on purpose. That one means
 * "the server rejected us", carries `statusCode`, and correctly feeds the auth
 * circuit breaker. This one means "we never asked", so it must NOT record an
 * auth failure — a request that was never sent is no evidence about the session,
 * and counting it would let ordinary cold starts trip a breaker that exists to
 * detect a dead session. The logger classifies it duck-typed by `name`, so
 * nothing here imports the classifier.
 */
export class NoCredentialError extends Error {
  readonly name = 'NoCredentialError';
  constructor(message: string) {
    super(message);
    // Re-set after super(): subclassing a built-in loses the prototype chain
    // under Hermes, and the logger's duck-typed check reads `name` off the
    // instance.
    Object.setPrototypeOf(this, NoCredentialError.prototype);
  }
}

const TAG = '[E2EE]';



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

function fetchWithTimeout(
  url: string,
  opts: RequestInit,
  // 30s to match the inference gateway's own attestation upstream timeout — a
  // shorter client abort would give up while the gateway is still fetching the
  // report, wasting the round trip and forcing a retry.
  ms = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/** Structured detail attached to a {@link ModelKeyValidationError}. The key is
 *  PUBLIC data — capturing/logging it is safe and intentional. */


// De-dupe Sentry captures by the raw bad-key hex: a run can build E2EE context
// for many batches against the same off-curve key, and we want exactly ONE event
// per distinct encoding (the next prod occurrence must reveal the actual bytes),
// not one per batch.
const reportedBadModelKeys = new Set<string>();

// In-flight attestation fetches, keyed by model.
//
// The 30-minute cache is only populated once a fetch RESOLVES, so on a cold
// cache every concurrent caller missed and started its own request. That is a
// stampede against a single endpoint: `prewarmCloudChat` alone fires three of
// these in one `Promise.allSettled` (lib/llm/prewarm.ts), and the scoring
// pipeline adds one per batch submit via `rebuildE2EEContext`. The gateway's
// NestJS throttler answered exactly as it should — `ThrottlerException: Too
// Many Requests` — and the 429 surfaced as a failed batch (MERA-APP-71).
//
// Deduping here rather than at each call site: the callers are independent
// (prewarm, chat, scoring) and none of them can see the others. Mirrors
// `_pendingJwtRequest` in auth-client, which solved this same problem for the
// JWT. Entries are removed in a `finally` so a REJECTED fetch is retryable
// immediately — a throttled attempt must not poison the next one.
const pendingAttestations = new Map<string, Promise<ModelAttestation>>();

/**
 * `lane` is the limiter lane the underlying gateway request runs on. It
 * defaults to 'background', which keeps every pre-existing caller (scoring,
 * the inference queue, the hygiene sweep) on exactly the pacing it had; chat
 * passes 'interactive' because a person is waiting on the turn this attests
 * for.
 *
 * NOTE on the dedupe below: it collapses concurrent callers PER MODEL, so an
 * interactive caller that joins a background caller's in-flight fetch inherits
 * that request's timing. That is correct — the request is already scheduled —
 * but it means the lane is a property of the first caller, not of every joiner.
 */
export async function fetchModelPublicKey(
  model: string,
  lane: gatewayRateLimiter.GatewayLane = 'background',
): Promise<ModelAttestation> {
  const cached = getCachedAttestation(model);
  if (cached) return cached;

  const inFlight = pendingAttestations.get(model);
  if (inFlight) return inFlight;

  const run = fetchModelPublicKeyUncached(model, lane).finally(() => {
    pendingAttestations.delete(model);
  });
  pendingAttestations.set(model, run);
  return run;
}

async function fetchModelPublicKeyUncached(
  model: string,
  lane: gatewayRateLimiter.GatewayLane,
): Promise<ModelAttestation> {
  // Dev-only timing: this is the uncached NEAR pass-through — the dominant
  // first-chat-latency hop we prewarm against. Cache hits above never reach here.
  const attestStartMs = Date.now();
  const token = await getJwtToken();
  // Fail BEFORE the network call. The route is guarded, so a tokenless request
  // cannot succeed; sending it anyway bought a guaranteed 401 on every
  // pre-session background sweep (MERA-APP-16). See NoCredentialError.
  if (!token) {
    throw new NoCredentialError(
      'NEAR attestation skipped: no session token, request not attempted',
    );
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };

  const url =
    `${ATTESTATION_API}?model=${encodeURIComponent(model)}&signing_algo=ed25519`;

  // ONE grant for the whole fetch, taken OUTSIDE withRetry. Inside the closure
  // it would charge the background lane's 3s spacing per attempt on a path that
  // already fans out on cold start; the retries below stay unmetered, which is
  // the deliberate (and bounded) exception.
  await gatewayRateLimiter.acquire(lane);

  const res = await withRetry(
    async () => {
      const r = await fetchWithTimeout(url, { headers });
      if (r.status >= 500) {
        const body = await r.text().catch(() => '');
        throw new NearAttestationError(r.status, body);
      }
      return r;
    },
    undefined,
    // 2 retries, not 5. This endpoint is a NEAR pass-through with a 30s client
    // timeout, so six attempts is three minutes of a cold start held open, and
    // every attempt is unmetered budget. Past the third the gateway is down,
    // not busy.
    2,
    TAG,
  );
  if (!res.ok) {
    // A 429 here is the throttle MERA-APP-71 actually hit, and this path was
    // the last gateway caller that did not back the device off for it.
    if (res.status === 429) {
      const retryAfterHeader = res.headers?.get?.('Retry-After');
      const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      const retryAfterMs =
        Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, 60_000)
          : 30_000;
      gatewayRateLimiter.pauseFor(retryAfterMs);
      logger.warn(`${TAG} attestation throttled (429) — pausing gateway calls`, {
        model,
        retryAfterMs,
      });
    }
    const body = await res.text().catch(() => '');
    throw new NearAttestationError(res.status, body);
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
  // Throws for any length that is neither 32 nor 64 — same message as before.
  const algo: SigningAlgo = algoForKeyBytes(keyLen);
  if (algo === 'ecdsa') {
    // Fail-fast validation: reconstruct the 65-byte uncompressed point
    // (0x04 ‖ x ‖ y) exactly as encryptEcdsa will, and assert it is actually on
    // secp256k1 NOW. Without this the off-curve key is only rejected later, deep
    // inside secp256k1.getSharedSecret at encrypt time, as an untyped
    // "bad point: is not on curve" that re-drove the poller every ~7s
    // (MERA-APP-39). The reconstructed point is NOT cached below — we throw
    // before setCachedAttestation, so a later run's fresh attestation fetch
    // (fleet load-balances curves) naturally retries.
    const raw = hexToBytes(pub);
    const point65 = new Uint8Array(65);
    point65[0] = 0x04;
    point65.set(raw, 1);
    try {
      // fromBytes does NOT check the curve (per @noble/curves v2) — assertValidity does.
      secp256k1.Point.fromBytes(point65).assertValidity();
    } catch (cause) {
      const err = new ModelKeyValidationError(
        `NEAR attestation: 64-byte ecdsa key is not a valid secp256k1 point (model=${model})`,
        { keyHex: pub, algo, model, endpoint: ATTESTATION_API, cause },
      );
      // Capture ONCE per distinct bad key — the hex is public data, logged
      // intentionally so the next occurrence reveals the real encoding.
      if (!reportedBadModelKeys.has(pub)) {
        reportedBadModelKeys.add(pub);
        logger.captureException(err, {
          tags: { service: 'e2ee', step: 'model-key-validate' },
          extra: { keyHex: pub, algo, model, endpoint: ATTESTATION_API },
        });
      }
      throw err;
    }
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

/** One model attestation entry, as far as verification cares about it. */
export interface RawModelAttestation {
  signing_public_key?: string;
  signing_algo?: string;
  request_nonce?: string;
  intel_quote?: string;
  nvidia_payload?: string;
}

/**
 * Fetch an attestation report FOR VERIFICATION, bound to a fresh client nonce.
 *
 * This is deliberately a SEPARATE path from {@link fetchModelPublicKey}:
 *
 *  - It sends a random `nonce`, which NEAR echoes into the quote's
 *    `report_data` (measured, not assumed). That is the only way a quote can be
 *    shown to be fresh rather than replayed.
 *  - Precisely because the nonce is unique, it busts all three caches — the
 *    30-minute client cache, the gateway's 10-minute cache (keyed on the exact
 *    query string), and NEAR's own upstream cache. So it pays a full cold
 *    round trip every time.
 *
 * That cost is why the inference hot path is NOT routed through here. The hot
 * path (prewarm, chat, scoring) keeps using the cached, nonce-free fetch, so
 * its attestation is chain-verifiable but NOT freshness-verifiable. Only the
 * user-initiated "Verify attestation" tap pays for freshness, which is the
 * right trade while verification is fail-open and gates nothing: a user asking
 * a security question can absorb a few seconds; every cold inference request
 * cannot.
 *
 * If verification is ever flipped to fail-closed, this trade must be revisited
 * — a fail-closed gate on a non-fresh attestation is a weaker guarantee than
 * it looks.
 */
export async function fetchAttestationForVerification(
  model: string,
  nonceHex: string,
): Promise<{ attestation: RawModelAttestation; nonce: string }> {
  const token = await getJwtToken();
  // Same guard as the hot path: the route is behind the gateway's AuthGuard, so
  // a tokenless request is a guaranteed 401 rather than a maybe. The verify tap
  // is user-initiated, so this is rarer than the background sweep that produced
  // MERA-APP-16 — but a 401 here would be just as meaningless, and the tap's own
  // catch cannot tell one failure from another.
  if (!token) {
    throw new NoCredentialError(
      'NEAR attestation skipped: no session token, request not attempted',
    );
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };

  const url =
    `${ATTESTATION_API}?model=${encodeURIComponent(model)}` +
    `&signing_algo=ed25519&nonce=${encodeURIComponent(nonceHex)}`;

  // INTERACTIVE, hardcoded: this function has exactly one caller, the user's
  // verify tap, and it bypasses every cache — so it is always a real request
  // with a person watching a spinner.
  await gatewayRateLimiter.acquire('interactive');

  const res = await fetchWithTimeout(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new NearAttestationError(res.status, body);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const mas = data.model_attestations as RawModelAttestation[] | undefined;
  const attestation = mas?.[0];
  if (!attestation) {
    throw new Error(
      `NEAR attestation: model_attestations missing. top=${Object.keys(data).join(',')}`,
    );
  }
  return { attestation, nonce: nonceHex };
}

/** 32 random bytes, hex — the shape NEAR's `nonce` param echoes into the
 *  quote's `report_data`. */
export function generateAttestationNonce(): string {
  return bytesToHex(randomBytes(32));
}

export async function prepareE2EEContext(
  model: string,
  lane: gatewayRateLimiter.GatewayLane = 'background',
): Promise<E2EEContext> {
  const attestation = await fetchModelPublicKey(model, lane);
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

  // X-Encryption-Version '2' identifies the ed25519 v2 scheme. The legacy ecdsa
  // scheme is unversioned — NEAR's documented ecdsa request omits the header, so
  // we do too (sending '2' with ecdsa could misroute to the v2 decryptor). That
  // rule lives in buildE2EEHeaders now; it used to be written out here AND in
  // rebuildE2EEContext, and it is the rule whose breakage is invisible until
  // NEAR answers 400.
  const headers: E2EEHeaders = buildE2EEHeaders(
    algo,
    clientPubKeyHex,
    attestation.publicKey,
  );

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
 * from the stored one (NEAR's fleet load-balances curves, and the attestation
 * cache only lives 30 minutes) the two halves are unusable together: the stored
 * keypair is bound to one curve and the fresh model key to the other. We throw
 * a TYPED {@link ModelKeyAlgoMismatchError} so the caller terminates the
 * affected batch/run and its rows re-enter the next run under a fresh, coherent
 * context.
 *
 * This previously warned and kept the stored algo, which produced MERA-APP-39:
 * the mismatch surfaced as an untyped noble error inside `encryptEd25519` —
 * NOT at decrypt, as the old comment assumed — uncaught, re-driving the poller
 * every ~7s and wedging the whole feed pipeline.
 */
export async function rebuildE2EEContext(
  model: string,
  privKeyHex: string,
  algo: SigningAlgo,
  lane: gatewayRateLimiter.GatewayLane = 'background',
): Promise<E2EEContext> {
  const attestation = await fetchModelPublicKey(model, lane);
  if (attestation.algo !== algo) {
    throw new ModelKeyAlgoMismatchError(
      `${TAG} rebuildE2EEContext: attested algo ${attestation.algo} != stored ${algo} (model=${model}); cannot pair a ${algo} keypair with a ${attestation.algo} model key`,
      {
        keyHex: attestation.publicKey,
        algo,
        model,
        endpoint: ATTESTATION_API,
      },
    );
  }
  const privateKey = hexToBytes(privKeyHex);
  if (privateKey.length !== CLIENT_SECRET_LEN) {
    throw new ModelKeyAlgoMismatchError(
      `${TAG} rebuildE2EEContext: stored client secret is ${privateKey.length} bytes, expected ${CLIENT_SECRET_LEN} (model=${model}, algo=${algo})`,
      { keyHex: attestation.publicKey, algo, model, endpoint: ATTESTATION_API },
    );
  }
  const clientPubKeyHex =
    algo === 'ecdsa'
      ? bytesToHex(secp256k1.getPublicKey(privateKey, false))
      : bytesToHex(ed25519.getPublicKey(privateKey));

  const headers: E2EEHeaders = buildE2EEHeaders(
    algo,
    clientPubKeyHex,
    attestation.publicKey,
  );

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
  lane: gatewayRateLimiter.GatewayLane = 'background',
): Promise<E2EEContext> {
  const ctx = await prepareE2EEContext(model, lane);
  for (const msg of messages) {
    if (typeof msg.content !== 'string' || msg.content.length === 0) continue;
    msg.content = encryptContent(msg.content, ctx);
  }
  return ctx;
}

