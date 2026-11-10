// route1 P8b: a scoring run is bound to ONE model profile (provider, model, key) chosen from the
// scoring lane at creation. Submits use that profile; when it goes down, unsent batches go into a
// new run on the next profile (never encrypted to another key), and the lane's outage is shown
// instead of an endless "Analyzing relevance".
import { http, HttpResponse } from 'msw';
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { getPipeline } from '@/lib/database/services/scoring-pipeline-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { server } from '@/test/helpers';
import {
  cleanupWorld,
  currentRun,
  gateway,
  ids,
  letKickPlayOut,
  passTime,
  patchRun,
  phases,
  resetPipelineWorld,
  rows,
  seedAndEnqueue,
  tick,
  tickUntil,
} from './scoring-pipeline-kit';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

const Q36 = 'Qwen/Qwen3.6-35B-A3B-FP8';

/** Attestation answers 503 for the named models; every other model falls through to the mock. */
function failAttestation(models: string[] | 'all') {
  server.use(
    http.get('*/api/attestation/report', ({ request }) => {
      const model = new URL(request.url).searchParams.get('model') ?? '';
      return models === 'all' || models.includes(model) ? new HttpResponse('down', { status: 503 }) : undefined;
    }),
  );
}

beforeEach(async () => {
  await resetPipelineWorld();
});
afterEach(cleanupWorld);

describe('a run is bound to one profile', () => {
  it('stores the scoring lane first profile and its key on the run', async () => {
    gateway();
    await seedAndEnqueue(ids(25));

    const run = await currentRun();
    expect(run?.profileId).toBe('near/qwen3.6-35b-a3b');
    expect(run?.modelPubKeyHex).toMatch(/^[0-9a-f]{64,}$/);
  });

  it('creates the run on the next profile when the first one cannot attest, and marks no outage', async () => {
    gateway();
    failAttestation([Q36]);
    await seedAndEnqueue(ids(25));

    expect((await currentRun())?.profileId).toBe('near/qwen3.8-27b');
    expect(useForYouStore.getState().laneOutage.scoring).toBeUndefined();
  });

  it('a run stored before profiles existed submits as the old SMALL_MODEL run did', async () => {
    gateway();
    await seedAndEnqueue(ids(25));
    await patchRun((run) => {
      delete run.profileId;
      delete run.modelPubKeyHex;
    });
    clearAttestationCache();

    await tickUntil(async () => (await phases()).some((p) => p === 'waiting-relevance'));

    expect((await currentRun())?.profileId).toBeUndefined();
  });
});

describe('a run whose profile goes down', () => {
  it('moves unsent batches into a new run on the next profile', async () => {
    gateway();
    await seedAndEnqueue(ids(25));
    const first = await currentRun();
    expect(first?.profileId).toBe('near/qwen3.6-35b-a3b');
    expect(await phases()).toEqual(['queued', 'queued', 'queued']);
    clearAttestationCache();
    failAttestation([Q36]);

    await tick();
    await letKickPlayOut();
    await tickUntil(async () => (await currentRun())?.profileId === 'near/qwen3.8-27b');

    const second = await currentRun();
    expect(second?.runId).not.toBe(first?.runId);
    expect(Object.values(await rows()).filter((r) => r.status === 'unscored').length).toBeGreaterThan(0);
  });

  it('with every profile down the run ends, the rows stay unscored, the phase is idle and the lane is out', async () => {
    gateway();
    await seedAndEnqueue(ids(25));
    clearAttestationCache();
    failAttestation('all');

    await tick();
    await letKickPlayOut();
    await passTime(130_000);

    expect(await getPipeline()).toBeNull();
    const store = useForYouStore.getState();
    expect(store.asyncJobPhase).toBe('idle');
    expect(store.laneOutage.scoring?.since).toEqual(expect.any(Number));
    const all = Object.values(await rows());
    expect(all.every((r) => r.status === 'unscored')).toBe(true);
  });
});
