// The Settings "Verify attestation" path: fetchAttestationForVerification (nonce'd, uncached) and the
// verifier over the report the gateway mock serves. Mirrors AttestationVerificationRow.run().
import { readFileSync } from 'fs';
import { join } from 'path';
import { gunzipSync } from 'zlib';
import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { AttestationVerificationRow } from '@/components/custom/config-mera/AttestationVerificationRow';
import { BIG_MODEL, SMALL_MODEL } from '@/lib/llm/constants';
import * as e2eeService from '@/lib/e2ee/e2ee-service';
import { initI18nEn } from '@/test/helpers';
import { getJwtToken, invalidateJwtCache } from '@/lib/auth-client';
import { verifyAttestation, type VerificationReport } from '@/lib/algorithms/attestation-verify';
import { clearAttestationCache, getCachedAttestation, setCachedAttestation } from '@/lib/e2ee/e2ee-cache';
import {
  fetchAttestationForVerification,
  generateAttestationNonce,
  NoCredentialError,
  type ModelAttestation,
} from '@/lib/e2ee/e2ee-service';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import { __resetRouterForTests as resetModelFallback } from '@/lib/llm/router';
import { attestationRequests, http, HttpResponse, server, signInFixtureAccount } from '@/test/helpers';
import { driveUntilDone, useStrictClock } from '@/test/integration/chat/_helpers';
import capturedReport from '@/test/fixtures/attestation-report.json';
import gpu1a from '@/test/fixtures/attestation/1gpu-004-0.json';
import composeManagerReport from '@/test/fixtures/attestation/compose-manager-report.json';

const ROUTE = '*/api/attestation/report';
const MODEL = 'some/model';
const NONCE = 'a1'.repeat(32);
const captured = capturedReport.model_attestations[0];

/** The nonce the client sent when the fixture was captured (see attestation-verify.test.ts). */
const CAPTURE_NONCE = '5ec0ffee'.repeat(8);
/** Inside the fixture's certificate validity windows. */
const NOW = new Date('2026-08-08T00:00:00Z');

interface Seen {
  model: string | null;
  algo: string | null;
  nonce: string | null;
  authorization: string | null;
  rawUrl: string;
  at: number;
}
let seen: Seen[] = [];

const run = <T,>(p: Promise<T>) => driveUntilDone(p);
const errorOf = (p: Promise<unknown>) =>
  driveUntilDone(p).then(
    () => null,
    (e: Error) => e,
  );

beforeEach(() => {
  resetLimiter();
  resetModelFallback();
  clearAttestationCache();
  invalidateJwtCache();
  seen = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (!url.pathname.endsWith('/api/attestation/report')) return;
    seen.push({
      model: url.searchParams.get('model'),
      algo: url.searchParams.get('signing_algo'),
      nonce: url.searchParams.get('nonce'),
      authorization: request.headers.get('authorization'),
      rawUrl: request.url,
      at: Date.now(),
    });
  });
});

afterEach(() => {
  server.events.removeAllListeners();
});

// Aliased: a function named use* trips react-hooks/rules-of-hooks wherever it is called.
const fakeClock = useStrictClock;

async function signedIn(): Promise<void> {
  await signInFixtureAccount();
  fakeClock(Date.now());
}

describe('fetchAttestationForVerification', () => {
  beforeEach(signedIn);

  it('sends the client nonce, the model and signing_algo in the query, and a bearer token', async () => {
    // The nonce is the whole freshness mechanism: NEAR echoes it into the quote's report_data.
    const { attestation, nonce } = await run(fetchAttestationForVerification(MODEL, NONCE));

    const token = await run(getJwtToken());
    expect(seen).toHaveLength(1);
    expect(seen[0].nonce).toBe(NONCE);
    expect(seen[0].model).toBe(MODEL);
    expect(seen[0].algo).toBe('ed25519');
    expect(seen[0].rawUrl).toContain(`nonce=${NONCE}`);
    expect(seen[0].rawUrl).toContain('model=some%2Fmodel');
    expect(seen[0].authorization).toBe(`Bearer ${token}`);
    expect(nonce).toBe(NONCE);
    expect(attestation).toEqual(captured);
    expect(attestation.signing_public_key).toBe(captured.signing_public_key);
  });

  it('bypasses the attestation cache: two calls, two requests on the nonce route', async () => {
    await run(fetchAttestationForVerification(MODEL, NONCE));
    await run(fetchAttestationForVerification(MODEL, NONCE));

    expect(seen).toHaveLength(2);
    // The mock counts the no-nonce (hot path) route only.
    expect(attestationRequests()).toBe(0);
  });

  it('neither reads nor writes the 30-minute hot-path cache', async () => {
    const hot: ModelAttestation = { publicKey: 'ab'.repeat(32), algo: 'ed25519' };
    setCachedAttestation(MODEL, hot);

    await run(fetchAttestationForVerification(MODEL, NONCE));

    expect(seen).toHaveLength(1);
    expect(getCachedAttestation(MODEL)).toBe(hot);

    clearAttestationCache();
    await run(fetchAttestationForVerification(MODEL, NONCE));
    expect(getCachedAttestation(MODEL)).toBeNull();
  });

  it('takes a limiter grant: back-to-back verifies are at least a second apart', async () => {
    await run(fetchAttestationForVerification(MODEL, NONCE));
    await run(fetchAttestationForVerification(MODEL, NONCE));
    expect(seen[1].at - seen[0].at).toBeGreaterThanOrEqual(1_000);
  });

  it('throws NearAttestationError carrying the status on a non-ok response, without retrying', async () => {
    server.use(http.get(ROUTE, () => new HttpResponse('upstream down', { status: 503 })));

    const err = await errorOf(fetchAttestationForVerification(MODEL, NONCE));

    expect(err).toMatchObject({
      name: 'NearAttestationError',
      statusCode: 503,
      message: 'NEAR attestation failed (503): upstream down',
    });
    expect(seen).toHaveLength(1);
  });

  it('throws when model_attestations is missing', async () => {
    server.use(http.get(ROUTE, () => HttpResponse.json({ gateway_attestation: {} })));
    await expect(run(fetchAttestationForVerification(MODEL, NONCE))).rejects.toThrow(
      'NEAR attestation: model_attestations missing. top=gateway_attestation',
    );
  });

  it('throws when model_attestations is present but empty', async () => {
    server.use(http.get(ROUTE, () => HttpResponse.json({ model_attestations: [] })));
    await expect(run(fetchAttestationForVerification(MODEL, NONCE))).rejects.toThrow(/model_attestations missing/);
  });
});

describe('fetchAttestationForVerification: no session', () => {
  beforeEach(() => {
    fakeClock(Date.now());
  });

  it('throws NoCredentialError without issuing a request', async () => {
    const err = await errorOf(fetchAttestationForVerification(MODEL, NONCE));

    expect(err).toBeInstanceOf(NoCredentialError);
    expect(err!.name).toBe('NoCredentialError');
    expect(seen).toHaveLength(0);
  });

  // The verify tap's catch maps any throw to its own error state, so the type is what tells it apart.
  it('does not dress the missing credential up as a 401', async () => {
    const err = await errorOf(fetchAttestationForVerification(MODEL, NONCE));
    expect(err).not.toHaveProperty('statusCode');
  });
});

describe('generateAttestationNonce', () => {
  it('is 32 random bytes as lower-case hex', () => {
    expect(generateAttestationNonce()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs on every call: a constant nonce would defeat the freshness check', () => {
    expect(generateAttestationNonce()).not.toBe(generateAttestationNonce());
  });
});

describe('verifyAttestation over the served report (what the Settings row does)', () => {
  beforeEach(signedIn);

  async function verifyWith(nonce: string): Promise<VerificationReport> {
    const { attestation } = await run(fetchAttestationForVerification('Qwen/Qwen3.8-27B', nonce));
    return verifyAttestation({
      quoteHex: attestation.intel_quote ?? '',
      signingPublicKey: attestation.signing_public_key ?? '',
      signingAlgo: attestation.signing_algo,
      expectedNonce: nonce,
      hasGpuPayload: Boolean(attestation.nvidia_payload),
      now: NOW,
    });
  }
  const status = (r: VerificationReport, id: string) => r.checks.find((c) => c.id === id)?.status;

  it('with the nonce the report was captured under it never throws and is incomplete, not verified', async () => {
    const report = await verifyWith(CAPTURE_NONCE);

    expect(report.verdict).toBe('incomplete');
    expect(report.verdict).not.toBe('verified');
    // The honest gaps: both need collateral the app does not fetch.
    expect(status(report, 'tcb-status')).toBe('not-checked');
    expect(status(report, 'gpu-attestation')).toBe('not-checked');
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
  });

  it('with the app\'s fresh random nonce the replayed report FAILS freshness and the verdict is failed', async () => {
    const report = await verifyWith(generateAttestationNonce());

    expect(status(report, 'freshness-nonce')).toBe('fail');
    expect(report.verdict).toBe('failed');
    expect(status(report, 'tcb-status')).toBe('not-checked');
    expect(status(report, 'gpu-attestation')).toBe('not-checked');
  });
});

describe('verifyAttestation with a served NVIDIA token', () => {
  beforeEach(signedIn);

  // Same wire shape the unit test builds from its fixture.
  const nvidia = { tokens: gpu1a.reply, keys: [(gpu1a as { jwk: unknown }).jwk] };
  const GPU_NOW = new Date('2026-11-06T02:30:00Z');
  const GPU_NONCE = 'ebbaa3eafb3f3765cccf6fd57750991f77ba33499838045bc31c4c3f58821a91';

  it('passes gpu-attestation at the fixture\'s time and nonce', async () => {
    server.use(
      http.get(ROUTE, () =>
        HttpResponse.json({
          model_attestations: [{ ...captured, nvidia_attestation: nvidia }],
        }),
      ),
    );
    jest.setSystemTime(GPU_NOW);
    const { attestation } = await run(fetchAttestationForVerification(MODEL, GPU_NONCE));
    const report = verifyAttestation({
      quoteHex: attestation.intel_quote ?? '',
      signingPublicKey: attestation.signing_public_key ?? '',
      signingAlgo: attestation.signing_algo,
      expectedNonce: GPU_NONCE,
      nvidiaAttestation: attestation.nvidia_attestation,
      now: GPU_NOW,
    });
    expect(report.checks.find((c) => c.id === 'gpu-attestation')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'tcb-status')?.status).toBe('not-checked');
  });
});

describe('AttestationVerificationRow: GPU notice', () => {
  const GPU_NONCE = 'ebbaa3eafb3f3765cccf6fd57750991f77ba33499838045bc31c4c3f58821a91';
  const nvidia = { tokens: gpu1a.reply, keys: [(gpu1a as { jwk: unknown }).jwk] };
  beforeAll(initI18nEn);
  beforeEach(async () => {
    await signInFixtureAccount();
    fakeClock('2026-11-06T02:30:00Z');
    jest.spyOn(e2eeService, 'generateAttestationNonce').mockReturnValue(GPU_NONCE);
  });
  afterEach(() => jest.restoreAllMocks());

  async function tapVerify() {
    const view = await render(React.createElement(AttestationVerificationRow));
    await fireEvent.press(view.getByTestId('mera-protocol-attestation-toggle'));
    await act(async () => {
      fireEvent.press(view.getByTestId('mera-protocol-attestation-run'));
      await run(Promise.resolve());
    });
    await run(Promise.resolve());
    return view;
  }

  it('shows the notice when NVIDIA\'s result passes', async () => {
    server.use(
      http.get(ROUTE, () =>
        HttpResponse.json({ model_attestations: [{ ...captured, nvidia_attestation: nvidia }] }),
      ),
    );
    const view = await tapVerify();
    expect(await view.findByTestId('attestation-gpu-notice')).toBeTruthy();
  });

  it('shows no notice when the GPU check fails', async () => {
    server.use(
      http.get(ROUTE, () =>
        HttpResponse.json({ model_attestations: [{ ...captured, nvidia_attestation: nvidia }] }),
      ),
    );
    // A nonce the token was not issued for: the check is `fail`, not `not-checked`.
    jest.spyOn(e2eeService, 'generateAttestationNonce').mockReturnValue('ab'.repeat(32));
    const view = await tapVerify();
    expect(await view.findByTestId('attestation-scope-notice')).toBeTruthy();
    expect(view.getAllByTestId('attestation-check-gpu-attestation')).toHaveLength(2);
    expect(view.queryByTestId('attestation-gpu-notice')).toBeNull();
  });

  it('shows no notice on the old gateway', async () => {
    const view = await tapVerify();
    expect(await view.findByTestId('attestation-scope-notice')).toBeTruthy();
    expect(view.queryByTestId('attestation-gpu-notice')).toBeNull();
  });
});

describe('AttestationVerificationRow: proxy identity', () => {
  const FILE_ROUTE = '*/api/attestation/compose-file';
  const report = composeManagerReport;
  const fixtureFile = (name: string) =>
    gunzipSync(readFileSync(join(__dirname, '../../../fixtures/attestation', name))).toString('utf8');
  const files: Record<string, string> = {
    '81da1f6290a2bdb2f8f7712ab8ca76c891f5660d': fixtureFile('compose-small-models-81da1f6.yaml.gz'),
    '75d31e6461dc51465a81ff69203200a51a820d1c': fixtureFile('compose-small-models-75d31e6.yaml.gz'),
  };
  let fileRequests: { commit: string | null; file: string | null; authorization: string | null }[];
  beforeAll(initI18nEn);
  beforeEach(async () => {
    await signInFixtureAccount();
    fakeClock('2026-11-06T09:45:00Z');
    fileRequests = [];
    jest.spyOn(e2eeService, 'generateAttestationNonce').mockReturnValue(report.request_nonce);
    server.use(
      http.get(ROUTE, () => HttpResponse.json({ model_attestations: [report] })),
      http.get(FILE_ROUTE, ({ request }) => {
        const url = new URL(request.url);
        const commit = url.searchParams.get('commit');
        fileRequests.push({
          commit,
          file: url.searchParams.get('file'),
          authorization: request.headers.get('authorization'),
        });
        return HttpResponse.text(files[commit ?? '']);
      }),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  async function tapVerify() {
    const view = await render(React.createElement(AttestationVerificationRow));
    await fireEvent.press(view.getByTestId('mera-protocol-attestation-toggle'));
    await act(async () => {
      fireEvent.press(view.getByTestId('mera-protocol-attestation-run'));
      await run(Promise.resolve());
    });
    await run(Promise.resolve());
    await view.findByTestId('attestation-scope-notice');
    return view;
  }

  it('fetches both files through the gateway, authenticated, and shows the notice', async () => {
    const view = await tapVerify();

    expect(view.getByTestId('attestation-deployed-software-notice')).toBeTruthy();
    expect(
      within(view.getByTestId(`attestation-model-${SMALL_MODEL}`)).getByText(
        "Proxy matches NEAR's public configuration",
      ),
    ).toBeTruthy();
    expect(new Set(fileRequests.map(r => r.commit))).toEqual(new Set(Object.keys(files)));
    expect(fileRequests.every(r => r.file === 'prod/small-models.yaml')).toBe(true);
    expect(fileRequests.every(r => r.authorization?.startsWith('Bearer '))).toBe(true);
  });

  it('reads as not checked, with no notice, when the gateway can not supply the file', async () => {
    server.use(http.get(FILE_ROUTE, () => HttpResponse.json({ error: 'x' }, { status: 502 })));
    const view = await tapVerify();

    expect(view.queryByTestId('attestation-deployed-software-notice')).toBeNull();
    expect(
      view.getAllByText("Proxy matches NEAR's public configuration · not checked"),
    ).toHaveLength(2);
  });

  it('fetches nothing from a gateway that sends no log', async () => {
    server.use(
      http.get(ROUTE, () =>
        HttpResponse.json({
          model_attestations: [{ ...report, compose_manager_attestation: undefined }],
        }),
      ),
    );
    const view = await tapVerify();

    expect(fileRequests).toEqual([]);
    expect(view.queryByTestId('attestation-deployed-software-notice')).toBeNull();
    expect(view.queryByTestId('attestation-detail-proxyImage')).toBeNull();
    expect(view.getAllByTestId('attestation-check-detail-deployed-software')[0]).toHaveTextContent(
      'no deployment log was served',
      { exact: false },
    );
  });

  it('asks for both models, and shows each one its own section and card', async () => {
    const view = await tapVerify();

    expect(new Set(seen.map(s => s.model))).toEqual(new Set([BIG_MODEL, SMALL_MODEL]));
    for (const model of [BIG_MODEL, SMALL_MODEL]) {
      const section = within(view.getByTestId(`attestation-model-${model}`));
      expect(section.getByText(`NEAR AI · ${model}`)).toBeTruthy();
      expect(section.getByTestId(`attestation-details-${model}`)).toBeTruthy();
      expect(section.getByTestId('attestation-detail-nonce')).toHaveTextContent(report.request_nonce, {
        exact: false,
      });
      expect(section.getByTestId('attestation-detail-mrtd')).toBeTruthy();
    }
  });

  it('shows the full image digest, file and commit that started the proxy', async () => {
    const view = await tapVerify();
    const card = within(view.getByTestId(`attestation-details-${SMALL_MODEL}`));

    expect(card.getByTestId('attestation-detail-proxyImage')).toHaveTextContent(
      'nearaidev/vllm-proxy-rs@sha256:0be4ee8f40a2bf71a6e2fab1e780ad1a6e738ffb2085553f1ed4b85fcb944207',
      { exact: false },
    );
    expect(card.getByTestId('attestation-detail-composeFile')).toHaveTextContent('prod/small-models.yaml', {
      exact: false,
    });
    expect(card.getByTestId('attestation-detail-composeTag')).toHaveTextContent('v0.0.540', { exact: false });
    expect(card.getByTestId('attestation-detail-composeCommit')).toHaveTextContent(
      '75d31e6461dc51465a81ff69203200a51a820d1c',
      { exact: false },
    );
    expect(card.getByTestId('attestation-detail-patchLevel')).toHaveTextContent('not checked', {
      exact: false,
    });
  });

  it('a model that can not be fetched does not hide the other, and the summary stays partial', async () => {
    server.use(
      http.get(ROUTE, ({ request }) =>
        new URL(request.url).searchParams.get('model') === BIG_MODEL
          ? HttpResponse.json({ error: 'x' }, { status: 503 })
          : HttpResponse.json({ model_attestations: [report] }),
      ),
    );
    const view = await tapVerify();

    expect(
      within(view.getByTestId(`attestation-model-${BIG_MODEL}`)).getByTestId('attestation-model-error'),
    ).toBeTruthy();
    expect(view.getByTestId(`attestation-details-${SMALL_MODEL}`)).toBeTruthy();
    expect(view.getByText('Partly verified')).toBeTruthy();
  });

  it('copies that model\'s card as JSON, and holds no account data', async () => {
    const copied = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
    const view = await tapVerify();

    await act(async () => {
      fireEvent.press(view.getByTestId(`attestation-copy-${SMALL_MODEL}`));
      await run(Promise.resolve());
    });

    const json = JSON.parse(copied.mock.calls[0][0]);
    expect(json.model).toBe(SMALL_MODEL);
    expect(json.nonce).toBe(report.request_nonce);
    expect(json.proxyImage).toContain('vllm-proxy-rs@sha256:');
    expect(json.checks).toHaveLength(12);
    expect(view.getByText('Copied')).toBeTruthy();
  });

  it('reads each check\'s status to a screen reader', async () => {
    const view = await tapVerify();
    const section = within(view.getByTestId(`attestation-model-${SMALL_MODEL}`));

    expect(section.getByLabelText('Quote signature is valid, passed')).toBeTruthy();
    expect(section.getByLabelText('Platform patch level is current, not checked')).toBeTruthy();
  });
});
