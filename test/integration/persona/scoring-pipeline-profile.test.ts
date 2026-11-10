// route1 P8b: a scoring run is bound to ONE model profile (provider, model, key) chosen from the
// scoring lane at creation. Submits use that profile; when it goes down, unsent batches go into a
// new run on the next profile (never encrypted to another key), and the lane's outage is shown
// instead of an endless "Analyzing relevance".
import { http, HttpResponse } from 'msw';
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { getPipeline } from '@/lib/database/services/scoring-pipeline-store';
import { PROFILES } from '@/lib/llm/profiles';
import { isProfileMarked, reportProfileFailure, routingVersion } from '@/lib/llm/router';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import * as scoringPipeline from '@/lib/services/scoring-pipeline';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { server } from '@/test/helpers';
import { setAppState } from '@/test/helpers/app-state';
import { serveRedPill } from '@/test/integration/chat/transport/transport-kit';
import {
  cleanupWorld,
  currentRun,
  drive,
  gateway,
  ids,
  letKickPlayOut,
  passTime,
  patchRun,
  phases,
  resetPipelineWorld,
  rows,
  seedAndEnqueue,
  seedArticles,
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

/** A routing table (the body of GET /v1/routing, also carried by a fast-fail 503) with `scoring` profiles. */
const table = (version: number, scoring: string[]) => ({
  version,
  updatedAt: '2026-11-10T00:00:00.000Z',
  lanes: { scoring: { state: 'degraded', profiles: scoring } },
});

/** The gateway's fast-fail for a down model, on the first job POST whose Idempotency-Key matches `phase` (`rel` | `r`). */
function failNextJob(phase: 'rel' | 'r', routing = table(5, ['near/qwen3.8-27b', 'redpill/qwen3.8-27b'])) {
  const hit: string[] = [];
  server.use(
    http.post('*/v1/inference/jobs', ({ request }) => {
      const key = request.headers.get('idempotency-key') ?? '';
      if (hit.length > 0 || !key.includes(`:${phase}:`)) return undefined;
      hit.push(key);
      return HttpResponse.json({ error: { code: 'model_unavailable', message: 'model down' }, routing }, { status: 503 });
    }),
  );
  return hit;
}

/** Idempotency-Key of every job POST, in order. */
function jobKeys(): string[] {
  const keys: string[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/v1/inference/jobs')) {
      keys.push(request.headers.get('idempotency-key') ?? '');
    }
  });
  return keys;
}

describe('a job submit the gateway fast-fails (503 model_unavailable)', () => {
  it('sends the same rows to the next profile at once, as a new run with its own key', async () => {
    gateway();
    await seedAndEnqueue(ids(25));
    const first = await currentRun();
    expect(first?.profileId).toBe('near/qwen3.6-35b-a3b');
    const keys = jobKeys();
    const rejected = failNextJob('rel');

    await tick();
    await letKickPlayOut();
    await tickUntil(async () => (await currentRun())?.profileId === 'near/qwen3.8-27b');

    const second = await currentRun();
    expect(rejected).toHaveLength(1);
    expect(second?.runId).not.toBe(first?.runId);
    // The table in the 503 was applied, and the down profile got ONE POST: no retry, no backoff.
    expect(routingVersion()).toBe(5);
    expect(keys.filter((k) => k.startsWith(`${first!.runId}:`))).toHaveLength(1);
    expect(isProfileMarked('near/qwen3.6-35b-a3b')).toBe(true);
    // Every row of the first run, the rejected batch's included, is in the new run.
    expect(second!.batches.flatMap((b) => b.candidateIds).sort()).toEqual(ids(25).sort());
    await tickUntil(async () => keys.some((k) => k.startsWith(`${second!.runId}:`)));
    expect(Object.values(await rows()).some((r) => r.scoreFailedAt != null)).toBe(false);
  });

  it('a reasons submit fast-failed keeps the scores and sends the notes to the next profile in a new run', async () => {
    gateway();
    const rejected = failNextJob('r');
    const keys = jobKeys();
    await seedAndEnqueue(ids(25));
    const first = await currentRun();

    await tickUntil(async () => {
      const run = await currentRun();
      return !!run && run.runId !== first?.runId && keys.some((k) => k.startsWith(`${run.runId}:`) && k.includes(':r:'));
    }, 40);

    expect(rejected).toHaveLength(1);
    expect((await currentRun())?.profileId).toBe('near/qwen3.8-27b');
    await tickUntil(async () => (await currentRun()) === null, 40);
    const all = Object.values(await rows());
    expect(all.every((r) => r.status !== ArticleSuggestionStatus.Unscored)).toBe(true);
    expect(all.filter((r) => r.reason).length).toBeGreaterThan(0);
  });
});

describe('scoring while only RedPill is healthy', () => {
  const ART = DEFAULT_HARNESS_CONFIG.articlePipeline;
  const REASON_SYSTEMS = new Set([ART.reasonSystemPrompt, ART.headlineReasonSystemPrompt]);
  const TITLE = /News Title: Story (\S+) saga/g;
  /** The sync scorer's two calls, told apart by their system prompt (as scoring-service.test.ts does). */
  const scorer = (messages: { role: string; content: string }[]) => {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const found = [...(messages.find((m) => m.role === 'user')?.content ?? '').matchAll(TITLE)].map((m) => m[1]);
    return REASON_SYSTEMS.has(system) ? `Why story ${found[0]} matters here.` : JSON.stringify(found.map(() => 0.9));
  };

  function nearDown(): void {
    failAttestation([Q36, 'Qwen/Qwen3.8-27B']);
    for (const id of ['near/qwen3.6-35b-a3b', 'near/qwen3.8-27b'] as const) {
      reportProfileFailure(PROFILES[id], 'scoring', 'attestation');
    }
  }

  it('in the foreground the waiting rows are scored over RedPill sync calls and the outage clears', async () => {
    gateway();
    nearDown();
    const rp = serveRedPill(scorer);
    setAppState('active');

    await seedAndEnqueue(ids(6), { flush: true });
    await passTime(30_000);

    expect(await getPipeline()).toBeNull();
    expect(rp.length).toBeGreaterThan(0);
    expect(new Set(rp.map((c) => c.nonce)).size).toBe(rp.length);
    const all = Object.values(await rows());
    expect(all.every((r) => r.status !== ArticleSuggestionStatus.Unscored)).toBe(true);
    expect(all.some((r) => r.reason === 'Why story id0 matters here.')).toBe(true);
    expect(useForYouStore.getState().laneOutage.scoring).toBeUndefined();
  });

  it('when the app goes to the background the pass stops and the rest stay unscored', async () => {
    gateway();
    nearDown();
    const rp = serveRedPill((messages) => {
      setAppState('background');
      return scorer(messages);
    });
    setAppState('active');

    await seedAndEnqueue(ids(60), { flush: true });
    await passTime(30_000);

    const sent = rp.length;
    await passTime(30_000);
    expect(rp.length).toBe(sent);
    const all = Object.values(await rows());
    expect(all.some((r) => r.status === ArticleSuggestionStatus.Unscored)).toBe(true);
    expect(all.some((r) => r.scoreFailedAt != null)).toBe(false);
  });

  it('a background wake sends nothing to RedPill', async () => {
    gateway();
    nearDown();
    const rp = serveRedPill(scorer);
    setAppState('background');
    await seedArticles(ids(25));

    await drive(scoringPipeline.submitScoringForBackground({ deadlineAt: Date.now() + 25_000, articleIds: ids(25) }));
    await drive(scoringPipeline.enqueueCandidates(ids(25), true));
    await passTime(30_000);

    expect(rp).toHaveLength(0);
    expect(Object.values(await rows()).every((r) => r.status === ArticleSuggestionStatus.Unscored)).toBe(true);
  });
});
