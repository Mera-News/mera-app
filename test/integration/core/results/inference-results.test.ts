// inference-results: the shared fetch/decode/persist primitives behind the cloud scoring pipeline.
//
// Real auth client, real E2EE (envelopes are sealed by the gateway mock and opened by the app's own
// keys), real article_suggestions rows on the in-memory DB. Network faults are MSW overrides.
import * as Sentry from '@sentry/react-native';
import * as authClient from '@/lib/auth-client';
import database from '@/lib/database';
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { prepareE2EEContext } from '@/lib/e2ee/e2ee-service';
import { sendInferenceRequest } from '@/lib/llm/submitInferenceJob';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import logger from '@/lib/logger';
import { CLOUD_SCORE_CHUNK_SIZE } from '@/lib/mera-protocol/scoring-service';
import {
  CAPABILITY_TOKEN_TTL_MS,
  TaskNoAuthError,
  discardLowRelevance,
  fetchResults,
  finalizeStrandedBelowReasonThreshold,
  hexToBytes,
  isRecordNotFoundError,
  REASON_RELEVANCE_THRESHOLD,
  pickResultsAuthHeader,
  reconstructLookups,
  toBatchResult,
  type ServerResults,
} from '@/lib/services/inference-results';
import {
  advanceUntilDone,
  delay,
  http,
  HttpResponse,
  mockGateway,
  server,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';
import { sealForClient } from '@/test/mock-backend/gateway/crypto';
import { rowsById, scorePendingReason, seedArticles } from './seed';

const RESULTS_ROUTE = '*/v1/inference/jobs/:id/results';

/** Answers the results route and records which job and Authorization header each GET carried. */
function captureResults(reply: () => Response | Promise<Response> = () => HttpResponse.json({ pending: true })) {
  const seen: { id: string; auth: string | null }[] = [];
  server.use(
    http.get(RESULTS_ROUTE, ({ request, params }) => {
      seen.push({ id: String(params.id), auth: request.headers.get('authorization') });
      return reply();
    }),
  );
  return seen;
}

/** Submits a real job through the gateway mock; returns the ids the app needs to read it back. */
async function submitJob(calls: { id: string; prompt: string }[]) {
  const ctx = await prepareE2EEContext(SMALL_MODEL);
  const sent = await sendInferenceRequest({
    bundle: { calls: calls.map((c) => ({ ...c, system: 'shared system' })) } as never,
    ctx,
    token: null,
    model: SMALL_MODEL,
    context: 'foreground',
  });
  if (sent.status !== 'ok') throw new Error(`submit ${sent.status}`);
  return { ctx, requestId: sent.requestId, capabilityToken: sent.capabilityToken };
}

beforeEach(() => {
  resetLimiter();
  clearAttestationCache();
  authClient.invalidateJwtCache();
});

afterEach(() => jest.restoreAllMocks());

describe('pickResultsAuthHeader', () => {
  it('foreground prefers the session JWT over the capability token', async () => {
    await signInFixtureAccount();
    const jwt = await authClient.getJwtToken();
    expect(jwt).toBeTruthy();
    await expect(pickResultsAuthHeader('foreground', 'req', 'batch-cap')).resolves.toBe(`Bearer ${jwt}`);
  });

  it('task context returns the JWT and never the capability token', async () => {
    await signInFixtureAccount();
    const jwt = await authClient.getJwtToken();
    await expect(pickResultsAuthHeader('task', 'req', 'batch-cap')).resolves.toBe(`Bearer ${jwt}`);
  });

  it('task context with no session throws TaskNoAuthError', async () => {
    await expect(pickResultsAuthHeader('task', 'req', 'batch-cap')).rejects.toBeInstanceOf(TaskNoAuthError);
  });

  it('task context lets a fired deadline through instead of reading it as a missing session', async () => {
    const deadline = new AbortController();
    deadline.abort();
    const err = await pickResultsAuthHeader('task', 'req', 'batch-cap', { signal: deadline.signal }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TaskNoAuthError);
  });

  it('TaskNoAuthError is a named Error that survives instanceof', () => {
    const err = new TaskNoAuthError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TaskNoAuthError);
    expect(err.name).toBe('TaskNoAuthError');
    expect(err.message).toBe('task /results: no JWT');
  });
});

describe('fetchResults: auth header', () => {
  it('uses the JWT bearer token in foreground context', async () => {
    await signInFixtureAccount();
    const jwt = await authClient.getJwtToken();
    const seen = captureResults();

    await fetchResults('req-1', 'foreground');

    expect(seen).toEqual([{ id: 'req-1', auth: `Bearer ${jwt}` }]);
  });

  it('falls back to the per-batch capability token when there is no session in foreground', async () => {
    const seen = captureResults();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await fetchResults('req-1', 'foreground', 'batch-cap');

    expect(seen).toEqual([{ id: 'req-1', auth: 'Bearer batch-cap' }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('capability-token fallback'));
  });

  it('falls back to the per-batch capability token when getJwtToken throws in foreground', async () => {
    const seen = captureResults();
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jest.spyOn(authClient, 'getJwtToken').mockRejectedValueOnce(new Error('keychain locked'));

    const res = await fetchResults('req-1', 'foreground', 'batch-cap');

    expect(res).toBe('pending');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('getJwtToken threw'));
    expect(seen).toEqual([{ id: 'req-1', auth: 'Bearer batch-cap' }]);
  });

  it('throws when foreground has no JWT and no capability token', async () => {
    const seen = captureResults();

    await expect(fetchResults('req-1', 'foreground')).rejects.toThrow('no auth available (foreground)');

    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('no JWT and no capability token'),
      }),
    );
    expect(seen).toEqual([]);
  });

  it('uses the per-batch capability token only in background context', async () => {
    await signInFixtureAccount();
    const seen = captureResults();
    const getJwt = jest.spyOn(authClient, 'getJwtToken');

    await fetchResults('req-1', 'background', 'bg-cap');

    expect(seen).toEqual([{ id: 'req-1', auth: 'Bearer bg-cap' }]);
    expect(getJwt).not.toHaveBeenCalled();
  });

  it('throws when background has no capability token', async () => {
    const seen = captureResults();

    await expect(fetchResults('req-1', 'background')).rejects.toThrow(
      'no capability token available (background)',
    );

    expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'background /results: no capability token' }),
    );
    expect(seen).toEqual([]);
  });

  it('task context uses the JWT and never the capability token', async () => {
    await signInFixtureAccount();
    const jwt = await authClient.getJwtToken();
    const seen = captureResults();

    await fetchResults('req-1', 'task', 'batch-cap');

    expect(seen).toEqual([{ id: 'req-1', auth: `Bearer ${jwt}` }]);
  });

  it('task context with no JWT throws TaskNoAuthError before any request', async () => {
    const seen = captureResults();

    await expect(fetchResults('req-1', 'task', 'batch-cap')).rejects.toBeInstanceOf(TaskNoAuthError);

    expect(seen).toEqual([]);
  });

  it('foreground skips a capability-token fallback past its 2h TTL', async () => {
    const seen = captureResults();

    await expect(
      fetchResults('req-1', 'foreground', 'batch-cap', {
        submittedAt: Date.now() - CAPABILITY_TOKEN_TTL_MS - 1_000,
      }),
    ).rejects.toThrow('no auth available (foreground)');

    expect(seen).toEqual([]);
  });

  it('foreground still uses a capability token inside its TTL', async () => {
    const seen = captureResults();

    await fetchResults('req-1', 'foreground', 'batch-cap', { submittedAt: Date.now() - 60_000 });

    expect(seen).toEqual([{ id: 'req-1', auth: 'Bearer batch-cap' }]);
  });

  it('background keeps an old capability token: the TTL skip is foreground-only', async () => {
    const seen = captureResults();

    await fetchResults('req-1', 'background', 'bg-cap', {
      submittedAt: Date.now() - CAPABILITY_TOKEN_TTL_MS - 1_000,
    });

    expect(seen).toEqual([{ id: 'req-1', auth: 'Bearer bg-cap' }]);
  });
});

describe('fetchResults: status handling', () => {
  it('returns "pending" while the job runs, then the decrypted rows once it completes', async () => {
    await signInFixtureAccount();
    server.use(
      ...mockGateway((c) => (c.callId === 'score:0' ? '  [0.9,0.2]  ' : 'a note'), { pendingPolls: 1 }),
    );
    const { ctx, requestId } = await submitJob([
      { id: 'score:0', prompt: 'p0' },
      { id: 'reason:x', prompt: 'p1' },
    ]);

    expect(await fetchResults(requestId, 'foreground')).toBe('pending');

    const res = (await fetchResults(requestId, 'foreground')) as ServerResults;
    expect(res.requestId).toBe(requestId);
    expect(res.results.map((r) => [r.id, r.ok])).toEqual([
      ['score:0', true],
      ['reason:x', true],
    ]);
    expect(res.results.map((r) => toBatchResult(r, ctx.privateKey, ctx.algo))).toEqual([
      { id: 'score:0', output: '[0.9,0.2]' },
      { id: 'reason:x', output: 'a note' },
    ]);
  });

  it('returns "not-found" on 404', async () => {
    await signInFixtureAccount();
    expect(await fetchResults('0'.repeat(24), 'foreground')).toBe('not-found');
  });

  it('returns "unauthorized" on 401', async () => {
    captureResults(() => new HttpResponse('Unauthorized', { status: 401 }));
    expect(await fetchResults('req-1', 'foreground', 'cap')).toBe('unauthorized');
  });

  it('returns "unauthorized" on 403 (a capability token minted for another job)', async () => {
    await signInFixtureAccount();
    server.use(...mockGateway(() => 'x'));
    const { requestId } = await submitJob([{ id: 'score:0', prompt: 'p' }]);

    expect(await fetchResults(requestId, 'background', 'cap.000000000000000000000099')).toBe('unauthorized');
  });

  it('a job completed with its own capability token reads back in background context', async () => {
    await signInFixtureAccount();
    server.use(...mockGateway(() => 'done'));
    const { ctx, requestId, capabilityToken } = await submitJob([{ id: 'reason:x', prompt: 'p' }]);

    const res = (await fetchResults(requestId, 'background', capabilityToken)) as ServerResults;

    expect(toBatchResult(res.results[0], ctx.privateKey, ctx.algo).output).toBe('done');
  });

  it('a call the gateway failed comes back as an ok=false row that decodes to its error', async () => {
    await signInFixtureAccount();
    server.use(...mockGateway((c) => (c.callId === 'reason:bad' ? { status: 502 } : 'fine')));
    const { ctx, requestId } = await submitJob([
      { id: 'reason:bad', prompt: 'p' },
      { id: 'reason:ok', prompt: 'p' },
    ]);

    const res = (await fetchResults(requestId, 'foreground')) as ServerResults;

    expect(res.results.map((r) => toBatchResult(r, ctx.privateKey, ctx.algo))).toEqual([
      { id: 'reason:bad', output: '', error: 'E2E mock: upstream 502' },
      { id: 'reason:ok', output: 'fine' },
    ]);
  });

  // Our own 30s timeout firing is expected behaviour on a slow link, not an exception. It used to
  // throw a literal `Error: aborted` that the caller captured to Sentry on every slow poll.
  it('returns "pending" when our own 30s timeout aborts the request', async () => {
    useFakeClock(Date.now());
    server.use(
      http.get(RESULTS_ROUTE, async () => {
        await delay('infinite');
        return HttpResponse.json({ pending: true });
      }),
    );
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const res = await advanceUntilDone(fetchResults('req-1', 'background', 'bg-cap'), 60_000);

    expect(res).toBe('pending');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out after 30000ms'), {
      requestId: 'req-1',
    });
  });

  it('returns "pending" when the background deadline signal aborts the request', async () => {
    const deadline = new AbortController();
    server.use(
      http.get(RESULTS_ROUTE, async () => {
        deadline.abort();
        await delay('infinite');
        return HttpResponse.json({ pending: true });
      }),
    );
    jest.spyOn(logger, 'warn').mockImplementation(() => {});

    const res = await fetchResults('req-1', 'background', 'bg-cap', { signal: deadline.signal });

    expect(res).toBe('pending');
  });

  it('still throws on a genuine network failure (signal not aborted)', async () => {
    server.use(http.get(RESULTS_ROUTE, () => HttpResponse.error()));
    await expect(fetchResults('req-1', 'background', 'bg-cap')).rejects.toThrow();
  });

  it('throws on a non-404/401/403 HTTP error and carries the body in the message', async () => {
    captureResults(() => HttpResponse.json({ error: 'server down' }, { status: 500 }));
    await expect(fetchResults('req-1', 'background', 'bg-cap')).rejects.toThrow(
      'results fetch 500 {"error":"server down"}',
    );
  });

  it('keeps a non-JSON error body as text', async () => {
    captureResults(() => new HttpResponse('upstream exploded', { status: 502 }));
    await expect(fetchResults('req-1', 'background', 'bg-cap')).rejects.toThrow(
      'results fetch 502 upstream exploded',
    );
  });

  it('handles an unreadable error body without crashing the error message', async () => {
    captureResults(
      () =>
        new HttpResponse(
          new ReadableStream({
            pull(controller) {
              controller.error(new Error('body read error'));
            },
          }),
          { status: 503 },
        ),
    );
    await expect(fetchResults('req-1', 'background', 'bg-cap')).rejects.toThrow(
      'results fetch 503 <unreadable body>',
    );
  });
});

describe('toBatchResult', () => {
  it.each(['ed25519', 'ecdsa'] as const)('%s: decrypts the choice content on an ok row, trimmed', async (curve) => {
    server.use(...mockGateway(() => 'x', { curve: { [SMALL_MODEL]: curve } }));
    await signInFixtureAccount();
    const ctx = await prepareE2EEContext(SMALL_MODEL);
    expect(ctx.algo).toBe(curve);
    const row: ServerResults['results'][number] = {
      id: 'reason:c1',
      ok: true,
      response: {
        choices: [{ message: { content: sealForClient('  decrypted output  ', ctx.clientPubKeyHex, ctx.algo) } }],
      },
    };

    expect(toBatchResult(row, ctx.privateKey, ctx.algo)).toEqual({ id: 'reason:c1', output: 'decrypted output' });
  });

  it('falls back to reasoning_content when content is absent', async () => {
    await signInFixtureAccount();
    const ctx = await prepareE2EEContext(SMALL_MODEL);
    const row: ServerResults['results'][number] = {
      id: 'reason:c1',
      ok: true,
      response: {
        choices: [
          { message: { reasoning_content: sealForClient('reasoned', ctx.clientPubKeyHex, ctx.algo) } },
        ],
      },
    };

    expect(toBatchResult(row, ctx.privateKey, ctx.algo).output).toBe('reasoned');
  });

  it('returns an error output for an ok=false row', async () => {
    await signInFixtureAccount();
    const ctx = await prepareE2EEContext(SMALL_MODEL);
    const failed: ServerResults['results'][number] = { id: 'reason:c1', ok: false, error: 'upstream error' };
    const unnamed: ServerResults['results'][number] = { id: 'reason:c2', ok: false };

    expect(toBatchResult(failed, ctx.privateKey, ctx.algo)).toEqual({
      id: 'reason:c1',
      output: '',
      error: 'upstream error',
    });
    expect(toBatchResult(unnamed, ctx.privateKey, ctx.algo)).toEqual({
      id: 'reason:c2',
      output: '',
      error: 'unknown',
    });
  });

  it('returns empty output when there is no encrypted content', async () => {
    await signInFixtureAccount();
    const ctx = await prepareE2EEContext(SMALL_MODEL);
    const noContent: ServerResults['results'][number] = {
      id: 'reason:c1',
      ok: true,
      response: { choices: [{ message: {} }] },
    };
    const noChoices: ServerResults['results'][number] = { id: 'reason:c2', ok: true };

    expect(toBatchResult(noContent, ctx.privateKey, ctx.algo)).toEqual({ id: 'reason:c1', output: '' });
    expect(toBatchResult(noChoices, ctx.privateKey, ctx.algo)).toEqual({ id: 'reason:c2', output: '' });
  });

  it('captures decrypt failures into the error field without throwing', async () => {
    await signInFixtureAccount();
    const ctx = await prepareE2EEContext(SMALL_MODEL);
    const row: ServerResults['results'][number] = {
      id: 'reason:c1',
      ok: true,
      response: { choices: [{ message: { content: 'not-a-real-envelope' } }] },
    };

    const out = toBatchResult(row, ctx.privateKey, ctx.algo);

    expect(out.id).toBe('reason:c1');
    expect(out.output).toBe('');
    expect(typeof out.error).toBe('string');
    expect(out.error).not.toBe('');
  });

  it('cannot open an envelope sealed toward a different client key', async () => {
    await signInFixtureAccount();
    const ctx = await prepareE2EEContext(SMALL_MODEL);
    const other = await prepareE2EEContext(SMALL_MODEL);
    const row: ServerResults['results'][number] = {
      id: 'reason:c1',
      ok: true,
      response: { choices: [{ message: { content: sealForClient('secret', other.clientPubKeyHex, other.algo) } }] },
    };

    const out = toBatchResult(row, ctx.privateKey, ctx.algo);

    expect(out.output).toBe('');
    expect(out.error).toBeTruthy();
  });
});

describe('reconstructLookups', () => {
  const size = CLOUD_SCORE_CHUNK_SIZE;
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `a${i}`);

  it('slices candidateIds into per-chunk candidate arrays keyed by score:N', () => {
    const candidateIds = ids(size + 2);
    const { chunkIdToCandidates } = reconstructLookups(['score:0', 'score:1'], candidateIds);

    expect(chunkIdToCandidates.get('score:0')!.map((c) => c.id)).toEqual(candidateIds.slice(0, size));
    expect(chunkIdToCandidates.get('score:1')!.map((c) => c.id)).toEqual(candidateIds.slice(size));
  });

  // P4b: an all-TOP-HEADLINE batch was chunked at 3, not 5. Decode passes the size persisted on the
  // batch; slicing with the standard size here would shift every score onto a neighbouring article
  // with no error raised anywhere.
  it('honours an explicit chunk size (headline batches chunk at 3)', () => {
    const candidateIds = ids(7);
    const { chunkIdToCandidates } = reconstructLookups(['score:0', 'score:1', 'score:2'], candidateIds, 3);

    expect(chunkIdToCandidates.get('score:0')!.map((c) => c.id)).toEqual(['a0', 'a1', 'a2']);
    expect(chunkIdToCandidates.get('score:1')!.map((c) => c.id)).toEqual(['a3', 'a4', 'a5']);
    expect(chunkIdToCandidates.get('score:2')!.map((c) => c.id)).toEqual(['a6']);
  });

  it('falls back to the standard size for a non-positive chunk size', () => {
    const candidateIds = ids(size + 1);
    const { chunkIdToCandidates } = reconstructLookups(['score:0'], candidateIds, 0);

    expect(chunkIdToCandidates.get('score:0')!.map((c) => c.id)).toEqual(candidateIds.slice(0, size));
  });

  it('ignores non-score call ids', () => {
    const { chunkIdToCandidates } = reconstructLookups(['reason:x', 'reason:y'], ['a', 'b']);
    expect(chunkIdToCandidates.size).toBe(0);
  });

  it('produces stub candidates with null metadata fields', () => {
    const { chunkIdToCandidates } = reconstructLookups(['score:0'], ['a']);
    expect(chunkIdToCandidates.get('score:0')![0]).toEqual({
      id: 'a',
      titleEn: null,
      descriptionEn: null,
      countryCode: null,
      userTopicIds: [],
      relatedFacts: [],
    });
  });
});

describe('discardLowRelevance', () => {
  // The keep threshold EQUALS the reason threshold (0.4). It was 0.3, and rows in between were neither
  // finalized nor sent for a reason: stuck in reason_pending forever (330 of them in one device snapshot).
  it('finalizes every row below the 0.4 reason threshold, keeps 0.4 and above, never deletes', async () => {
    const all = ['a', 'b', 'c', 'e', 'd'];
    await seedArticles(all);
    const relevance = { a: 0.1, b: 0.3, c: 0.35, e: 0.4, d: 0.9 };
    for (const id of all) await scorePendingReason(id, relevance[id as keyof typeof relevance]);

    const n = await discardLowRelevance(all, relevance);

    expect(n).toBe(3);
    // a, b and c are below 0.4; e (exactly 0.4) gets a reason, so it is kept.
    expect(await rowsById(all)).toEqual({
      a: { status: 'complete', relevance: 0.1 },
      b: { status: 'complete', relevance: 0.3 },
      c: { status: 'complete', relevance: 0.35 },
      e: { status: 'reason_pending', relevance: 0.4 },
      d: { status: 'reason_pending', relevance: 0.9 },
    });
  });

  it('skips ids with no relevance entry', async () => {
    await seedArticles(['a', 'b']);
    await scorePendingReason('a', 0.1);
    await scorePendingReason('b', 0.1);

    const n = await discardLowRelevance(['a', 'b'], { a: 0.1 });

    expect(n).toBe(1);
    expect(await rowsById(['a', 'b'])).toEqual({
      a: { status: 'complete', relevance: 0.1 },
      b: { status: 'reason_pending', relevance: 0.1 },
    });
  });

  it('returns 0 without touching the DB when nothing is below threshold', async () => {
    await seedArticles(['a']);
    await scorePendingReason('a', 0.9);

    expect(await discardLowRelevance(['a'], { a: 0.9 })).toBe(0);
    expect(await rowsById(['a'])).toEqual({ a: { status: 'reason_pending', relevance: 0.9 } });
  });

  it('rows at or above 0.4 are left untouched', async () => {
    await seedArticles(['a', 'b', 'c']);
    await scorePendingReason('a', 0.9);
    await scorePendingReason('b', 0.5);
    await scorePendingReason('c', 0.1);

    await discardLowRelevance(['a', 'b', 'c'], { a: 0.9, b: 0.5, c: 0.1 });

    expect(await rowsById(['a', 'b', 'c'])).toEqual({
      a: { status: 'reason_pending', relevance: 0.9 },
      b: { status: 'reason_pending', relevance: 0.5 },
      c: { status: 'complete', relevance: 0.1 },
    });
  });

  it('counts a row that vanished mid-flight without rejecting the batch', async () => {
    await seedArticles(['a']);
    await scorePendingReason('a', 0.1);

    const n = await discardLowRelevance(['a', 'gone'], { a: 0.1, gone: 0.1 });

    expect(n).toBe(2);
    expect(await rowsById(['a', 'gone'])).toEqual({ a: { status: 'complete', relevance: 0.1 }, gone: undefined });
  });
});

describe('finalizeStrandedBelowReasonThreshold', () => {
  it('finalizes stranded rows below 0.4 that no live batch covers', async () => {
    const all = ['stuck', 'covered', 'reason', 'unscored'];
    await seedArticles(all);
    await scorePendingReason('stuck', 0.35);
    await scorePendingReason('covered', 0.32);
    await scorePendingReason('reason', 0.4);

    const n = await finalizeStrandedBelowReasonThreshold(
      [
        { id: 'stuck', relevance: 0.35 },
        { id: 'covered', relevance: 0.32 },
        { id: 'reason', relevance: 0.4 },
        { id: 'unscored', relevance: null },
      ],
      new Set(['covered']),
    );

    expect(n).toBe(1);
    expect(await rowsById(all)).toEqual({
      stuck: { status: 'complete', relevance: 0.35 },
      covered: { status: 'reason_pending', relevance: 0.32 },
      reason: { status: 'reason_pending', relevance: 0.4 },
      unscored: { status: 'unscored', relevance: 0 },
    });
  });

  it('touches nothing when nothing is stranded', async () => {
    await seedArticles(['x']);
    await scorePendingReason('x', 0.7);

    expect(await finalizeStrandedBelowReasonThreshold([{ id: 'x', relevance: 0.7 }], new Set())).toBe(0);
    expect(await rowsById(['x'])).toEqual({ x: { status: 'reason_pending', relevance: 0.7 } });
  });

  it('is idempotent once the sweep has finalized the rows', async () => {
    await seedArticles(['stuck']);
    await scorePendingReason('stuck', 0.35);
    await finalizeStrandedBelowReasonThreshold([{ id: 'stuck', relevance: 0.35 }], new Set());

    // The orphan sweep only reads reason_pending rows, so the second pass is handed nothing.
    expect(await finalizeStrandedBelowReasonThreshold([], new Set())).toBe(0);
    expect(await rowsById(['stuck'])).toEqual({ stuck: { status: 'complete', relevance: 0.35 } });
  });
});

describe('isRecordNotFoundError', () => {
  it('matches Watermelon "Record ... not found" messages', async () => {
    expect(isRecordNotFoundError(new Error('Record article_suggestions#c1 not found'))).toBe(true);
    expect(isRecordNotFoundError('record article_suggestions#c1 NOT   found')).toBe(true);
  });

  it('matches the error the real DB throws for a deleted row', async () => {
    const err = await database.get('article_suggestions').find('missing').catch((e: unknown) => e);
    expect(isRecordNotFoundError(err)).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isRecordNotFoundError(new Error('some other db error'))).toBe(false);
  });
});

describe('hexToBytes', () => {
  it('decodes a hex string to a Uint8Array', () => {
    expect(Array.from(hexToBytes('000fff'))).toEqual([0, 15, 255]);
  });

  it('handles an empty string', () => {
    expect(hexToBytes('').length).toBe(0);
  });
});

describe('REASON_RELEVANCE_THRESHOLD', () => {
  it('is the documented 0.4 gate (relevance v3: moves in lockstep with RENDER_GATE)', () => {
    expect(REASON_RELEVANCE_THRESHOLD).toBe(0.4);
  });
});
