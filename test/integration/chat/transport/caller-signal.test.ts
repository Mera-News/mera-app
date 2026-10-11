// The caller's signal through cloudComplete: the name-only AbortError classification, a caller
// abort ending the call with no retry and no model-failure report, and the signal bridge React
// Native runs in production (no AbortSignal.any, so combineSignals bridges with listeners).
import { cloudComplete, isAbortLike, isCallerAbort } from '@/lib/llm/cloudComplete';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import { advanceUntil, CHAT_PATH, errorOf, fakeClock, resetTransport, respond, run, watchRequests } from './transport-kit';

const REQUEST = { systemPrompt: 'sys', prompt: 'p' };

// React Native has no AbortSignal.any. jest.replaceProperty refuses a function property, so the
// original is saved, removed and put back by hand.
const signalCtor = AbortSignal as unknown as { any?: unknown };
const realAny = signalCtor.any;
const removeAny = () => {
  delete signalCtor.any;
};
afterEach(() => {
  signalCtor.any = realAny;
  jest.restoreAllMocks();
});

beforeEach(async () => {
  await resetTransport();
  fakeClock();
});

it('classifies an error named AbortError as abort-like by its name alone', () => {
  const timedOut = Object.assign(new Error('The operation timed out.'), { name: 'AbortError' });
  expect(isAbortLike(timedOut)).toBe(true);
  expect(isAbortLike(new Error('The operation timed out.'))).toBe(false);
});

// The same abort case twice: with the runtime's AbortSignal.any, and without it (React Native).
describe.each([
  ['with AbortSignal.any', false],
  ['without AbortSignal.any (production)', true],
])('a caller abort %s', (_label, withoutAny) => {
  beforeEach(() => {
    if (withoutAny) removeAny();
  });

  it('ends the call with one request, no retry, and no session fallback', async () => {
    server.use(...mockGateway(respond({ chunks: ['late'], headerDelayMs: 600_000 })));
    const controller = new AbortController();
    const chat = watchRequests(CHAT_PATH);
    // One timeout attempt in the budget: if the abort were treated as a plain network error, the
    // budget would be spent and the raw AbortError would surface instead of the caller's stop.
    const outcome = errorOf(
      cloudComplete(
        { ...REQUEST, model: SMALL_MODEL },
        { signal: controller.signal, maxTimeoutAttempts: 1 },
      ),
    );
    await advanceUntil(() => chat.count() === 1);

    controller.abort();
    const err = await run(outcome);
    await jest.advanceTimersByTimeAsync(300_000);

    expect(isCallerAbort(err)).toBe(true);
    expect(gatewayCalls('chat')).toHaveLength(1);

    server.use(...mockGateway(respond('fine')));
    expect(await run(cloudComplete({ ...REQUEST, model: SMALL_MODEL }))).toBe('fine');
    const calls = gatewayCalls('chat');
    expect(calls[calls.length - 1].model).toBe(SMALL_MODEL);
  });
});

describe('the signal bridge without AbortSignal.any', () => {
  beforeEach(() => {
    removeAny();
  });

  it('removes every abort listener it added once the call settles', async () => {
    server.use(...mockGateway(respond('ok')));
    const controller = new AbortController();
    const added = jest.spyOn(controller.signal, 'addEventListener');
    const removed = jest.spyOn(controller.signal, 'removeEventListener');

    expect(await run(cloudComplete(REQUEST, { signal: controller.signal }))).toBe('ok');

    const abortAdds = added.mock.calls.filter(([type]) => type === 'abort');
    expect(abortAdds.length).toBeGreaterThan(0);
    for (const [type, listener] of abortAdds) {
      expect(removed).toHaveBeenCalledWith(type, listener);
    }
  });

  it('leaves no timer behind once the call settles', async () => {
    server.use(...mockGateway(respond('ok')));
    const controller = new AbortController();
    const before = jest.getTimerCount();

    expect(await run(cloudComplete(REQUEST, { signal: controller.signal }))).toBe('ok');

    expect(jest.getTimerCount()).toBe(before);
  });
});
