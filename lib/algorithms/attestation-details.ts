/**
 * The facts behind one Verify tap, for the details card and its copy button.
 *
 * Every value is public attestation data, so nothing here can identify the reader.
 * `osImageHash` is the one value no signature covers: it comes from the report's
 * unsigned `info`, and the card labels it as reported.
 */
import { quoteMeasurements, type CheckStatus, type VerificationReport } from './attestation-verify';
import type { DeployedProxy } from './deployed-software';

export interface AttestationDetails {
  checkedAt: string;
  nonce: string;
  encryptionKey?: string;
  algorithm?: string;
  mrtd?: string;
  rtmr0?: string;
  rtmr1?: string;
  rtmr2?: string;
  rtmr3?: string;
  composeHash?: string;
  osImageHash?: string;
  patchLevel?: CheckStatus;
  gpuCount?: number;
  proxyImage?: string;
  composeFile?: string;
  composeTag?: string;
  composeCommit?: string;
}

export interface AttestationDetailsInput {
  checkedAt: Date;
  nonce: string;
  signingPublicKey?: string;
  signingAlgo?: string;
  quoteHex: string;
  info?: unknown;
  report: VerificationReport;
  proxy?: DeployedProxy;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function reportedOsImageHash(info: unknown): string | undefined {
  const hash = (info as { os_image_hash?: unknown } | null | undefined)?.os_image_hash;
  return typeof hash === 'string' && HASH_PATTERN.test(hash) ? hash : undefined;
}

export function attestationDetails(input: AttestationDetailsInput): AttestationDetails {
  const { report, proxy } = input;
  const check = (id: 'tcb-status' | 'gpu-attestation') => report.checks.find(c => c.id === id);
  return {
    checkedAt: input.checkedAt.toISOString(),
    nonce: input.nonce,
    encryptionKey: input.signingPublicKey || undefined,
    algorithm: input.signingAlgo || undefined,
    ...quoteMeasurements(input.quoteHex),
    osImageHash: reportedOsImageHash(input.info),
    patchLevel: check('tcb-status')?.status,
    gpuCount: check('gpu-attestation')?.gpuCount,
    proxyImage: proxy?.image,
    composeFile: proxy?.file,
    composeTag: proxy?.tag,
    composeCommit: proxy?.commit,
  };
}
