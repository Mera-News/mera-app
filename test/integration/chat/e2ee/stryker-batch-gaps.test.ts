// lib/e2ee/e2ee-service.ts: the one line only a legacy suite reached. The service's own
// decryptContent binds the attestation endpoint and defaults the curve to ed25519; every other
// seam test opens envelopes through e2ee-crypto, which has no default.
import { invalidateJwtCache } from '@/lib/auth-client';
import { _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { decryptContent, encryptContent, prepareE2EEContext } from '@/lib/e2ee/e2ee-service';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { __resetForTests as resetModelFallback } from '@/lib/llm/model-fallback';
import { __resetOnDeviceGateForTests } from '@/lib/llm/on-device-gate';
import { signInFixtureAccount } from '@/test/helpers';
import { driveUntilDone, useStrictClock } from '@/test/integration/chat/_helpers';
import { TEST_MODEL_KEYS } from '@/test/mock-backend/gateway/keys';

const MODEL = 'test-model';
// Aliased: a function named use* trips react-hooks/rules-of-hooks wherever it is called.
const fakeClock = useStrictClock;

beforeEach(async () => {
  resetLimiter();
  resetModelFallback();
  clearAttestationCache();
  invalidateJwtCache();
  resetBreaker();
  __resetOnDeviceGateForTests();
  await signInFixtureAccount();
  fakeClock(Date.now());
});

describe('e2ee-service decryptContent', () => {
  it('opens an ed25519 envelope when the curve is left out', async () => {
    const ctx = await driveUntilDone(prepareE2EEContext(MODEL));
    expect(ctx.algo).toBe('ed25519');

    // Request direction: the model opens what the context seals, with no algo argument.
    const sealed = encryptContent('sealed toward the model', ctx);
    expect(decryptContent(sealed, TEST_MODEL_KEYS.ed25519.secret)).toBe('sealed toward the model');

    // Response direction: a reply sealed toward the client key opens with the context's own key.
    const reply = encryptContent('reply toward the client', { ...ctx, modelPubKeyHex: ctx.clientPubKeyHex });
    expect(decryptContent(reply, ctx.privateKey)).toBe('reply toward the client');
  });
});
