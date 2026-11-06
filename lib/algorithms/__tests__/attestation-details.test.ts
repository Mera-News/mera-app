import capturedReport from '@/test/fixtures/attestation-report.json';

import { attestationDetails } from '../attestation-details';
import { quoteMeasurements, type VerificationReport } from '../attestation-verify';

const quoteHex = capturedReport.model_attestations[0].intel_quote;
const report: VerificationReport = {
  verdict: 'incomplete',
  checks: [
    { id: 'tcb-status', status: 'not-checked', detail: '' },
    { id: 'gpu-attestation', status: 'pass', detail: '', gpuCount: 8 },
  ],
};
const input = { checkedAt: new Date('2026-11-06T10:00:00Z'), nonce: 'ab', quoteHex, report };

describe('quoteMeasurements', () => {
  it('reads the fields at their TD report offsets', () => {
    const body = quoteHex.toLowerCase();
    const at = (offset: number, length: number) => body.slice(offset * 2, (offset + length) * 2);
    const m = quoteMeasurements(quoteHex);

    expect(m?.mrtd).toBe(at(184, 48));
    expect(m?.rtmr0).toBe(at(376, 48));
    expect(m?.rtmr3).toBe(at(520, 48));
  });

  it('reads the compose hash only from dstack\'s MRCONFIGID shape', () => {
    const type = (byte: string) => quoteHex.slice(0, 232 * 2) + byte + quoteHex.slice(233 * 2);

    expect(quoteMeasurements(type('01'))?.composeHash).toBe(type('01').slice(233 * 2, 265 * 2).toLowerCase());
    expect(quoteMeasurements(type('02'))).not.toHaveProperty('composeHash');
  });

  it('is null for a quote it can not parse', () => {
    expect(quoteMeasurements('00')).toBeNull();
  });
});

describe('attestationDetails', () => {
  it('carries the patch status and GPU count from the checks', () => {
    expect(attestationDetails(input)).toMatchObject({
      checkedAt: '2026-11-06T10:00:00.000Z',
      patchLevel: 'not-checked',
      gpuCount: 8,
    });
  });

  it('leaves out what the report did not carry', () => {
    const details = attestationDetails({ ...input, quoteHex: '', signingPublicKey: '', signingAlgo: '' });

    expect(details.encryptionKey).toBeUndefined();
    expect(details.algorithm).toBeUndefined();
    expect(details.mrtd).toBeUndefined();
    expect(details.proxyImage).toBeUndefined();
  });

  it('shows the unsigned OS hash only when it is a hash', () => {
    const hash = 'ab'.repeat(32);

    expect(attestationDetails({ ...input, info: { os_image_hash: hash } }).osImageHash).toBe(hash);
    expect(attestationDetails({ ...input, info: { os_image_hash: '<x>' } }).osImageHash).toBeUndefined();
    expect(attestationDetails({ ...input, info: 'nope' }).osImageHash).toBeUndefined();
  });
});
