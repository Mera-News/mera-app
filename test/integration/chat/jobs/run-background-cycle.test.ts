// runBackgroundCycle (lib/background/run-inference-handler.ts): the three trigger families, run
// through the REAL scoring pipeline, gate, DB, stores, limiter and gateway mock.
//
//   scoring-pass  foreground: unscored fact-backed articles go out as relevance jobs under the JWT
//   app-resume    foreground: recover() drives whatever is in flight
//   silent-push / phase1-done / phase2-done: background, capability token only, advances a batch
//
// Replaces lib/background/__tests__/run-inference-handler.test.ts (13) and
// run-inference-handler-hard-filter.test.ts (3). The push-type -> reason mapping and the request-id
// routing are in inference-task.test.ts.
import database from '@/lib/database';
import * as suggestions from '@/lib/database/services/article-suggestion-reads';
import { loadSuggestions } from '@/lib/database/services/article-suggestion-reads';
import { saveScoringResult } from '@/lib/database/services/article-suggestion-scoring-writes';
import { getPipeline } from '@/lib/database/services/scoring-pipeline-store';
import { addSuppression } from '@/lib/database/services/suppression-service';
import { runBackgroundCycle } from '@/lib/background/run-inference-handler';
import logger from '@/lib/logger';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { gatewayCalls, server } from '@/test/helpers';
import {
  drive,
  gatewayPolls,
  reasonJobCalls,
  settleSubmits,
  settleUntil,
  ids,
  resetCycleWorld,
  seedArticles,
  submitJobs,
  watchResultsGets,
} from './support';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

jest.setTimeout(90_000);

beforeEach(resetCycleWorld);
afterEach(() => {
  server.events.removeAllListeners();
  jest.restoreAllMocks();
});

const rows = async () => Object.fromEntries((await loadSuggestions()).map((s) => [s._id, s]));
const jobPrompts = () => gatewayCalls('job').map((c) => c.messages.map((m) => m.content).join('\n')).join('\n');
const renderable = (all: Awaited<ReturnType<typeof rows>>) =>
  Object.values(all).filter((r) => (r.relevance ?? 0) > 0.3).length;
const waitingJobIds = async () => (await getPipeline())?.run.batches.map((b) => b.requestId) ?? [];

describe('scoring-pass', () => {
  it('sends the unscored fact-backed articles as one relevance job under the JWT, with an idempotency key', async () => {
    await seedArticles(ids(5).map((id) => ({ id })));

    const out = await drive(runBackgroundCycle('scoring-pass'));
    await settleSubmits();

    expect(out).toBe('running');
    const jobs = gatewayCalls('job');
    expect(jobs.map((c) => c.callId)).toEqual(['score:0']);
    for (const id of ids(5)) expect(jobPrompts()).toContain(`Story ${id} saga${id}`);
    // Foreground: the keychain JWT, never a capability token.
    expect(jobs[0].headers.authorization).toMatch(/^Bearer [^ ]+$/);
    expect(jobs[0].headers.authorization).not.toMatch(/^Bearer cap\./);
    const runId = (await getPipeline())!.run.runId;
    expect(jobs[0].headers['idempotency-key']).toBe(`${runId}:0:rel:0`);
  });

  it('holds back fewer than one chunk of articles: nothing is sent and the pipeline is idle', async () => {
    await seedArticles(ids(3).map((id) => ({ id })));
    expect(await drive(runBackgroundCycle('scoring-pass'))).toBe('idle');
    expect(gatewayCalls('job')).toHaveLength(0);
    expect(await getPipeline()).toBeNull();
  });

  it('with nothing unscored it is idle and does no gateway work', async () => {
    expect(await drive(runBackgroundCycle('scoring-pass'))).toBe('idle');
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('sends only articles eligible to be scored: factless rows never reach the gateway', async () => {
    await seedArticles([...ids(5).map((id) => ({ id })), ...ids(3, 'nofact').map((id) => ({ id, factless: true }))]);
    expect(await drive(runBackgroundCycle('scoring-pass'))).toBe('running');
    await settleSubmits();
    expect(jobPrompts()).toContain('Story id0 sagaid0');
    expect(jobPrompts()).not.toContain('nofact');
  });

  it('is safe to fire twice: articles already in flight are not submitted again', async () => {
    await seedArticles(ids(5).map((id) => ({ id })));
    await drive(runBackgroundCycle('scoring-pass'));
    expect(await drive(runBackgroundCycle('scoring-pass'))).toBe('running');
    await settleSubmits();
    expect(gatewayCalls('job').filter((c) => c.callId === 'score:0')).toHaveLength(1);
    expect(await waitingJobIds()).toHaveLength(1);
  });
});

describe('scoring-pass with a hard filter on a propagated story sibling (P9)', () => {
  /** A scored donor, two unscored siblings in its story, and five unrelated articles to score. */
  async function seedStory() {
    await seedArticles([{ id: 'donor', clusterId: 'c1', title: 'Chip story donor' }]);
    await saveScoringResult('donor', { relevance: 0.9, reason: '', reasonSkipped: true });
    await seedArticles([
      { id: 'blocked', clusterId: 'c1', title: 'Nvidia ships a GPU' },
      { id: 'ok', clusterId: 'c1', title: 'AMD ships a GPU' },
      ...ids(5, 'x').map((id) => ({ id })),
    ]);
  }
  const blockNvidia = () => addSuppression({ pattern: 'nvidia', keywords: ['nvidia'], strength: 1, source: 'chat' });

  it('excludes the blocked sibling that inherited a passing score, and never submits either sibling', async () => {
    await seedStory();
    await blockNvidia();
    const seen: (string | undefined)[] = [];
    const unsubscribe = useForYouStore.subscribe((s) => seen.push(s.suggestions.find((x) => x._id === 'blocked')?.status));

    const out = await drive(runBackgroundCycle('scoring-pass'));
    await settleSubmits();
    unsubscribe();

    expect(out).toBe('running');
    const all = await rows();
    expect(all.blocked).toMatchObject({ status: 'excluded' });
    expect(all.ok).toMatchObject({ relevance: 0.9 });
    expect(all.ok.status).not.toBe('excluded');
    // The Feed never drew the blocked article as a renderable row, not even for a frame.
    expect(seen).not.toContain('complete');
    // Only the unrelated articles went to the model.
    expect(jobPrompts()).toContain('Story x0 sagax0');
    expect(jobPrompts()).not.toContain('Nvidia');
    expect(jobPrompts()).not.toContain('AMD ships');
  });

  it('with no hard filter the siblings keep the donor\'s score and nothing is excluded', async () => {
    await seedStory();
    await drive(runBackgroundCycle('scoring-pass'));
    const all = await rows();
    expect(all.blocked.relevance).toBe(0.9);
    expect(all.ok.relevance).toBe(0.9);
    expect(Object.values(all).map((r) => r.status)).not.toContain('excluded');
  });

  it('a failing sweep is reported but never fails the cycle; the propagation stands', async () => {
    await seedStory();
    await blockNvidia();
    const boom = new Error('persona unavailable');
    const collection = database.get('persona_suppressions');
    const original = collection.query.bind(collection);
    const spy = jest.spyOn(collection, 'query').mockImplementationOnce((() => {
      throw boom;
    }) as typeof collection.query);
    spy.mockImplementation(original as never);

    const out = await drive(runBackgroundCycle('scoring-pass'));

    expect(out).toBe('running');
    expect(logger.captureException).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ tags: expect.objectContaining({ step: 'reconcile-hard-filters' }) }),
    );
    expect((await rows()).ok.relevance).toBe(0.9);
  });
});

describe('app-resume', () => {
  it('with nothing in flight is idle and silent', async () => {
    const gets = watchResultsGets();
    expect(await drive(runBackgroundCycle('app-resume'))).toBe('idle');
    expect(gets).toEqual([]);
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('drives a finished job to its scores under the JWT and keeps running for the reasons', async () => {
    const [id] = await submitJobs(ids(5));
    gatewayPolls(0);
    await jest.advanceTimersByTimeAsync(2_000);
    const gets = watchResultsGets();

    const out = await drive(runBackgroundCycle('app-resume'));
    await settleUntil(() => reasonJobCalls().length > 0);

    expect(out).toBe('running');
    expect(gets[0].id).toBe(id);
    expect(gets[0].auth).not.toMatch(/^Bearer cap\./);
    expect(renderable(await rows())).toBe(5);
    // The impactful ones are owed a note: a second (reasons) job went out.
    expect(reasonJobCalls().length).toBeGreaterThan(0);
  });
});

describe('background completion pushes', () => {
  it.each(['silent-push', 'phase1-done', 'phase2-done'] as const)(
    '%s collects the named job with the capability token and reports the pipeline status',
    async (reason) => {
      const [id] = await submitJobs(ids(5));
      gatewayPolls(0);
      await jest.advanceTimersByTimeAsync(2_000);
      const gets = watchResultsGets();

      const out = await drive(runBackgroundCycle(reason, id));

      expect(gets).toEqual([{ id, auth: `Bearer cap.${id}` }]);
      expect(out).toBe('running');
      expect(renderable(await rows())).toBe(5);
    },
  );

  it('with no request id it ticks the waiting jobs, oldest first', async () => {
    const jobs = await submitJobs(ids(5, 'a'), ids(5, 'b'));
    gatewayPolls(0);
    await jest.advanceTimersByTimeAsync(2_000);
    const gets = watchResultsGets();
    await drive(runBackgroundCycle('silent-push'));
    expect(gets[0].id).toBe(jobs[0]);
    expect(gets.every((g) => jobs.includes(g.id) && g.auth === `Bearer cap.${g.id}`)).toBe(true);
  });

  it('is idle when the pipeline has nothing', async () => {
    expect(await drive(runBackgroundCycle('phase1-done', 'a'.repeat(24)))).toBe('idle');
  });
});

describe('failures are reported, never thrown', () => {
  const run = (reason: Parameters<typeof runBackgroundCycle>[0]) => runBackgroundCycle(reason, 'req-1');

  it('an unexpected error from a scoring pass is error / kind generic at error level', async () => {
    const err = new Error('network failure');
    jest.spyOn(suggestions, 'getUnscoredSuggestionsWithFacts').mockRejectedValueOnce(err);
    expect(await run('scoring-pass')).toBe('error');
    expect(logger.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        level: 'error',
        tags: expect.objectContaining({ service: 'run-background-cycle', reason: 'scoring-pass', kind: 'generic' }),
      }),
    );
  });

  it('a locked keychain is a warning tagged keychain-unavailable', async () => {
    const err = new Error('SecItem errSecInteractionNotAllowed keychain locked');
    jest.spyOn(pipeline, 'handlePush').mockRejectedValueOnce(err);
    expect(await run('silent-push')).toBe('error');
    expect(logger.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ level: 'warning', tags: expect.objectContaining({ kind: 'keychain-unavailable' }) }),
    );
  });

  it('a transient abort is a warning tagged transient-network', async () => {
    const err = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    jest.spyOn(suggestions, 'getUnscoredSuggestionsWithFacts').mockRejectedValueOnce(err);
    expect(await run('scoring-pass')).toBe('error');
    expect(logger.captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ level: 'warning', tags: expect.objectContaining({ kind: 'transient-network' }) }),
    );
  });

  it('an error from app-resume\'s recover is generic', async () => {
    jest.spyOn(pipeline, 'recover').mockRejectedValueOnce(new Error('some random failure'));
    expect(await run('app-resume')).toBe('error');
    expect(logger.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ level: 'error', tags: expect.objectContaining({ kind: 'generic' }) }),
    );
  });

  it('a thrown non-Error is still an error result and is reported', async () => {
    jest.spyOn(pipeline, 'handlePush').mockRejectedValueOnce('string error');
    expect(await run('phase1-done')).toBe('error');
    expect(logger.captureException).toHaveBeenCalledWith('string error', expect.anything());
  });
});
