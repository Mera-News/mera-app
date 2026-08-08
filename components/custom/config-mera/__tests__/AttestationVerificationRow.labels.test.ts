/**
 * Label-map integrity for the attestation verification row.
 *
 * WHY THIS EXISTS. The row renders its labels through a `tk()` cast (the
 * `meraProtocol.attestation*` keys are not in `en.json` yet — they arrive as a
 * locale fragment spliced in at translation time). A cast means i18next's
 * missing-key behaviour applies: a typo'd or missing key renders the RAW KEY
 * STRING. On a security screen the failure mode is eleven rows reading
 * "meraProtocol.attestationCheckPckChain" instead of prose — visible, ugly, and
 * exactly the sort of thing that ships because no test looked.
 *
 * These assertions are structural, so they hold whether or not the fragment has
 * landed, and they start failing the moment a new check is added to the
 * verifier without a matching label.
 */
import { CHECK_LABEL_KEYS, CHECK_ORDER } from '../AttestationVerificationRow';
import { verifyAttestation } from '@/lib/e2ee/attestation-verify';
import fixture from '@/lib/e2ee/__tests__/fixtures/attestation-report.json';

const att = fixture.model_attestations[0];

/** Every check id the verifier actually emits, taken from a real run rather
 *  than a hand-maintained list that could drift from the implementation. */
const EMITTED_IDS = verifyAttestation({
  quoteHex: att.intel_quote,
  signingPublicKey: att.signing_public_key,
  signingAlgo: att.signing_algo,
  expectedNonce: '5ec0ffee'.repeat(8),
  hasGpuPayload: true,
  now: new Date('2026-08-08T00:00:00Z'),
}).checks.map(c => c.id);

describe('attestation check labels', () => {
  it('has a label key for every check the verifier emits', () => {
    // Adding a check to attestation-verify.ts without a label here would
    // render a raw key string in the UI.
    for (const id of EMITTED_IDS) {
      expect(CHECK_LABEL_KEYS[id]).toBeDefined();
    }
  });

  it('displays every check the verifier emits — none silently dropped', () => {
    // CHECK_ORDER drives rendering; an id missing from it is invisible in the
    // UI even though the verifier evaluated it. For a "not-checked" item that
    // would quietly hide a disclosed gap.
    for (const id of EMITTED_IDS) {
      expect(CHECK_ORDER).toContain(id);
    }
  });

  it('orders exactly the labelled checks, with no duplicates', () => {
    expect(new Set(CHECK_ORDER).size).toBe(CHECK_ORDER.length);
    expect([...CHECK_ORDER].sort()).toEqual(Object.keys(CHECK_LABEL_KEYS).sort());
  });

  it('uses a distinct, correctly-namespaced key per check', () => {
    const values = Object.values(CHECK_LABEL_KEYS);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v).toMatch(/^meraProtocol\.attestationCheck[A-Za-z]+$/);
  });

  it('keeps the honest gaps in the rendered list', () => {
    // The whole feature is undermined if these two stop being displayed.
    expect(CHECK_ORDER).toContain('tcb-status');
    expect(CHECK_ORDER).toContain('gpu-attestation');
  });
});
