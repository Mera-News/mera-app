// route1 P7: a batch caller keeps working when only RedPill is healthy. RedPill cannot take a batch
// (one header set, a reused nonce), so cloudBatchComplete sends each item as its own sync request on
// RedPill: a fresh nonce each, at most 4 at a time, the same prompts and params, results in item
// order. Only while the app is in front; otherwise the lane is out and RedPill gets nothing.
import { cloudBatchComplete } from '@/lib/llm/cloudComplete';
import { PROFILES } from '@/lib/llm/profiles';
import { reportProfileFailure } from '@/lib/llm/router';
import type { BatchCall } from '@/lib/llm/types';
import logger from '@/lib/logger';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { gatewayCalls, mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import { setAppState } from '@/test/helpers/app-state';
import { BATCH_PATH, errorOf, fakeClock, resetTransport, respond, run, serveRedPill, watchRequests } from './transport-kit';

const RP_MODEL = PROFILES['redpill/qwen3.8-27b'].model;

const calls = (n: number): BatchCall[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    system: `system ${i}`,
    prompt: `prompt ${i}`,
    temperature: 0.2,
    maxTokens: 50 + i,
  }));

const echo = (messages: { role: string; content: string }[]) =>
  `answer to ${messages.find((m) => m.role === 'user')?.content}`;

/** Both NEAR profiles are marked; `serving: false` also makes their batch route answer 502. */
function nearDown({ serving = true } = {}): void {
  if (!serving) server.use(...mockGateway(respond({ status: 502, body: 'gateway timeout' })));
  for (const id of ['near/qwen3.6-35b-a3b', 'near/qwen3.8-27b'] as const) {
    reportProfileFailure(PROFILES[id], 'background', 'upstream');
  }
}

beforeEach(async () => {
  await resetTransport({ signIn: false });
  await signInFixtureAccount();
  fakeClock();
  setAppState('active');
  useForYouStore.setState({ laneOutage: {} });
});

afterEach(() => {
  server.events.removeAllListeners();
  setAppState('active');
});

describe('cloudBatchComplete with only RedPill healthy', () => {
  it('sends every item as its own RedPill request and returns the results in item order', async () => {
    nearDown();
    const rp = serveRedPill(echo);
    const batch = watchRequests(BATCH_PATH);

    const results = await run(cloudBatchComplete(calls(6), 'topics'));

    expect(results).toEqual(calls(6).map((c) => ({ id: c.id, output: `answer to ${c.prompt}` })));
    expect(batch.count()).toBe(0);
    expect(rp).toHaveLength(6);
    expect(new Set(rp.map((c) => c.nonce)).size).toBe(6);
    // Same prompts and params as the batch would have carried.
    const byPrompt = new Map(rp.map((c) => [c.messages[1].content, c]));
    for (const c of calls(6)) {
      const sent = byPrompt.get(c.prompt)!;
      expect(sent.model).toBe(RP_MODEL);
      expect(sent.messages[0]).toEqual({ role: 'system', content: c.system });
      expect(sent.body).toMatchObject({ temperature: c.temperature, max_tokens: c.maxTokens, stream: false });
    }
    expect(useForYouStore.getState().laneOutage.topics).toBeUndefined();
  });

  it('a NEAR batch that fails on every NEAR profile is sent per item on RedPill, unnoticed', async () => {
    server.use(...mockGateway(respond({ status: 502, body: 'gateway timeout' })));
    const rp = serveRedPill(echo);

    const results = await run(cloudBatchComplete(calls(2)));

    expect(results.map((r) => r.output)).toEqual(['answer to prompt 0', 'answer to prompt 1']);
    expect(gatewayCalls('batch')).toHaveLength(2);
    expect(rp).toHaveLength(2);
  });

  it('in the background RedPill gets nothing and the lane is out', async () => {
    nearDown({ serving: false });
    const rp = serveRedPill(echo);
    const capture = jest.spyOn(logger, 'captureException').mockImplementation(() => undefined as never);
    setAppState('background');

    const err = await run(errorOf(cloudBatchComplete(calls(2), 'topics')));

    expect(err).not.toBeNull();
    expect(rp).toHaveLength(0);
    expect(useForYouStore.getState().laneOutage.topics?.since).toEqual(expect.any(Number));
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'LaneExhaustedError' }),
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('RedPill down too: one lane-exhausted event, and the per-item sends stop', async () => {
    nearDown({ serving: false });
    const rp = serveRedPill(() => ({ status: 502 }));
    const capture = jest.spyOn(logger, 'captureException').mockImplementation(() => undefined as never);

    const err = await run(errorOf(cloudBatchComplete(calls(12), 'topics')));

    expect(err).not.toBeNull();
    expect(rp.length).toBeLessThanOrEqual(4);
    expect(capture.mock.calls.filter(([e]) => (e as Error).name === 'LaneExhaustedError')).toHaveLength(1);
  });
});
