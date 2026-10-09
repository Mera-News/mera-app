// cloudComplete (the single buffered completion) against the gateway mock: real auth, real E2EE
// both ways, real limiter, real model fallback. What the model side received comes from the mock's
// decrypted call log; what is only visible on the wire (temperature, max_tokens, the thinking flag,
// that nothing is in the clear) comes from the raw request body.
import { _getBreakerState, _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import { MODEL_FALLBACKS, SMALL_MODEL } from '@/lib/llm/constants';
import {
  cloudBatchComplete,
  cloudComplete,
  UPSTREAM_ALIGNED_MAX_TIMEOUT_ATTEMPTS,
  UPSTREAM_ALIGNED_TIMEOUT_MS,
} from '@/lib/llm/cloudComplete';
import { isFallbackEngaged } from '@/lib/llm/model-fallback';
import logger from '@/lib/logger';
import { attestationRequests, gatewayCalls, mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import {
  BATCH_PATH,
  CHAT_PATH,
  errorOf,
  fakeClock,
  resetTransport,
  respond,
  run,
  serveJson,
  watchRequests,
} from './transport-kit';

const SECRET_SYSTEM = 'SENTINEL-SYSTEM-5e2a you are the test model';
const SECRET_USER = 'SENTINEL-USER-b07c what is the news';
const REQUEST = { systemPrompt: SECRET_SYSTEM, prompt: SECRET_USER };
const FALLBACK_MODEL = MODEL_FALLBACKS[SMALL_MODEL];

beforeEach(async () => {
  await resetTransport({ signIn: false });
});

afterEach(() => {
  server.events.removeAllListeners();
});

const signedIn = async () => {
  await signInFixtureAccount();
  fakeClock();
};

describe('cloudComplete', () => {
  beforeEach(signedIn);

  it('seals both prompts, returns the decrypted reply, and nothing readable leaves the device', async () => {
    server.use(...mockGateway(respond('hello from model')));
    const chat = watchRequests(CHAT_PATH);

    const result = await run(cloudComplete(REQUEST));

    expect(result).toBe('hello from model');
    const [call] = gatewayCalls('chat');
    expect(call).toMatchObject({ stream: false, model: SMALL_MODEL, algo: 'ed25519' });
    expect(call.messages).toEqual([
      { role: 'system', content: SECRET_SYSTEM },
      { role: 'user', content: SECRET_USER },
    ]);
    const [raw] = await chat.raw();
    expect(raw).not.toContain('SENTINEL');
  });

  it('merges the E2EE headers with the bearer', async () => {
    await run(cloudComplete(REQUEST));

    const { headers } = gatewayCalls('chat')[0];
    expect(headers.authorization).toMatch(/^Bearer /);
    expect(headers['x-signing-algo']).toBe('ed25519');
    expect(headers['x-encryption-version']).toBe('2');
  });

  it('uses the model it is given', async () => {
    await run(cloudComplete({ ...REQUEST, model: 'custom-model' }));
    expect(gatewayCalls('chat')[0].model).toBe('custom-model');
  });

  it('defaults to SMALL_MODEL', async () => {
    await run(cloudComplete(REQUEST));
    expect(gatewayCalls('chat')[0].model).toBe(SMALL_MODEL);
  });

  it.each([
    ['the default 0.3', undefined, 0.3],
    ['the one provided', 0.7, 0.7],
  ])('sends %s as temperature', async (_label, temperature, expected) => {
    const chat = watchRequests(CHAT_PATH);

    await run(cloudComplete({ ...REQUEST, temperature }));

    expect((await chat.json())[0].temperature).toBe(expected);
  });

  it('is not streamed and has thinking OFF by default', async () => {
    const chat = watchRequests(CHAT_PATH);

    await run(cloudComplete(REQUEST));

    const [body] = await chat.json();
    expect(body.stream).toBe(false);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it.each([
    ['maxTokens', { maxTokens: 1 }, 1],
    ['maxCompletionTokens when maxTokens is absent', { maxCompletionTokens: 8 }, 8],
    ['maxTokens over maxCompletionTokens', { maxTokens: 3, maxCompletionTokens: 8 }, 3],
    ['nothing', {}, undefined],
  ])('sends max_tokens from %s', async (_label, extra, expected) => {
    const chat = watchRequests(CHAT_PATH);

    await run(cloudComplete({ ...REQUEST, ...extra }));

    expect((await chat.json())[0].max_tokens).toBe(expected);
  });

  it('trims the decrypted reply', async () => {
    server.use(...mockGateway(respond('  padded  ')));
    expect(await run(cloudComplete(REQUEST))).toBe('padded');
  });

  it('strips a reasoning trace the model leaked into the content', async () => {
    server.use(...mockGateway(respond('private trace of thought</think>The answer.')));
    expect(await run(cloudComplete(REQUEST))).toBe('The answer.');
  });

  it('returns the reply as is when it holds no think tags', async () => {
    server.use(...mockGateway(respond('A plain answer with <b>markup</b>.')));
    expect(await run(cloudComplete(REQUEST))).toBe('A plain answer with <b>markup</b>.');
  });

  it('CH16 today: a reasoning-only reply is returned as the answer', async () => {
    serveJson(CHAT_PATH, (seal) => ({
      choices: [{ message: { content: '', reasoning_content: seal('thinking...') }, finish_reason: 'length' }],
    }));
    expect(await run(cloudComplete(REQUEST))).toBe('thinking...');
  });

  // CH16: the batch path fails loud on this reply; the single call hands the trace to its caller as the answer.
  test.failing('CH16: a reasoning-only reply fails loud instead of returning the trace', async () => {
    serveJson(CHAT_PATH, (seal) => ({
      choices: [{ message: { content: '', reasoning_content: seal('thinking...') }, finish_reason: 'length' }],
    }));

    const err = await run(errorOf(cloudComplete(REQUEST)));

    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('reasoning-overran-budget');
  });

  it.each([
    ['content and reasoning_content both empty', { choices: [{ message: { content: '', reasoning_content: '' } }] }],
    ['choices absent', { id: 'x' }],
    ['message absent in the choice', { choices: [{ finish_reason: 'stop' }] }],
  ])('returns an empty string when %s', async (_label, body) => {
    serveJson(CHAT_PATH, () => body);
    expect(await run(cloudComplete(REQUEST))).toBe('');
  });

  it('throws on a non-ok reply, naming the status and the body, and does not retry a 4xx', async () => {
    server.use(...mockGateway(respond({ status: 400, body: 'bad request' })));
    const chat = watchRequests(CHAT_PATH);

    const err = await run(errorOf(cloudComplete(REQUEST)));

    expect(err?.message).toMatch(/E2EE completion failed: 400/);
    expect(err?.message).toContain('bad request');
    expect(chat.count()).toBe(1);
  });

  // CH17: the status rides only in the message, so retry.ts and the logger's 401 rule (which read
  // statusCode / response.status) cannot see it. P3 adds the field and leaves the message text alone.
  const NON_OK = [401, 503] as const;
  const failWith = async (status: number) => {
    server.use(...mockGateway(respond({ status, body: 'gateway said no' })));
    const err = await run(errorOf(cloudComplete(REQUEST)));
    expect(err).toBeInstanceOf(Error);
    return err as Error & { statusCode?: number };
  };

  test.failing('CH17: a non-ok completion carries its status as a field', async () => {
    for (const status of NON_OK) {
      const err = await failWith(status);
      expect(err.statusCode).toBe(status);
      expect(err.message).toMatch(new RegExp(`E2EE completion failed: ${status}`));
    }
  });

  it('CH17 today: a non-ok completion has no statusCode field', async () => {
    for (const status of NON_OK) {
      const err = await failWith(status);
      expect(err.statusCode).toBeUndefined();
      expect(err.message).toMatch(new RegExp(`E2EE completion failed: ${status}`));
    }
  });

  // The consequence: callers hand the error to logger.captureException, whose 401 rule feeds the auth
  // breaker from statusCode. A dead session that survives the re-mint never reaches it.
  test.failing('CH17: a 401 that survives the re-mint reaches the auth breaker', async () => {
    resetBreaker();
    const err = await failWith(401);

    logger.captureException(err, { tags: { service: 'cloud-complete-test' } });

    expect(_getBreakerState().consecutiveFailures).toBe(1);
  });

  it('CH17 today: a 401 that survives the re-mint never reaches the auth breaker', async () => {
    resetBreaker();
    const err = await failWith(401);

    logger.captureException(err, { tags: { service: 'cloud-complete-test' } });

    expect(_getBreakerState().consecutiveFailures).toBe(0);
  });
});

describe('cloudComplete signed out', () => {
  beforeEach(fakeClock);

  it('fails before anything is sent when there is no credential', async () => {
    const chat = watchRequests(CHAT_PATH);

    const err = await run(errorOf(cloudComplete(REQUEST)));

    expect(err).toBeInstanceOf(Error);
    expect(chat.count()).toBe(0);
    expect(attestationRequests()).toBe(0);
    expect(gatewayCalls()).toEqual([]);
  });
});

describe('gateway-aligned timeout defaults', () => {
  beforeEach(signedIn);

  it('are 130s per attempt and 2 timeout attempts, outlasting the gateway 120s upstream limit', () => {
    expect(UPSTREAM_ALIGNED_TIMEOUT_MS).toBe(130_000);
    expect(UPSTREAM_ALIGNED_TIMEOUT_MS).toBeGreaterThan(120_000);
    expect(UPSTREAM_ALIGNED_MAX_TIMEOUT_ATTEMPTS).toBe(2);
  });

  it('a gateway verdict that lands at 125s is waited for', async () => {
    server.use(...mockGateway(respond({ chunks: ['slow but here'], headerDelayMs: 125_000 })));
    const chat = watchRequests(CHAT_PATH);

    expect(await run(cloudComplete(REQUEST), 600_000, 250)).toBe('slow but here');
    expect(chat.count()).toBe(1);
  });

  it('a silent gateway costs two 130s attempts on the primary, then ONE on the fallback', async () => {
    server.use(...mockGateway(respond({ chunks: ['never'], headerDelayMs: 900_000 })));
    const chat = watchRequests(CHAT_PATH);

    const err = await run(errorOf(cloudComplete(REQUEST)), 900_000, 250);

    expect(err?.message).toMatch(/abort|cancel/i);
    expect(chat.count()).toBe(3);
    expect(chat.times()[1] - chat.times()[0]).toBeGreaterThanOrEqual(UPSTREAM_ALIGNED_TIMEOUT_MS);
    expect(chat.times()[1] - chat.times()[0]).toBeLessThan(UPSTREAM_ALIGNED_TIMEOUT_MS + 5_000);
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([SMALL_MODEL, SMALL_MODEL, FALLBACK_MODEL]);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
  });

  it('cloudBatchComplete caps 502 attempts at 2 by default, plus one fallback retry (it was 11)', async () => {
    server.use(...mockGateway(respond({ status: 502, body: 'gateway timeout' })));
    const batch = watchRequests(BATCH_PATH);

    const err = await run(errorOf(cloudBatchComplete([{ id: 'c1', system: 's', prompt: 'p', temperature: 0.3 }])));

    expect(err?.message).toMatch(/E2EE batch failed: 502/);
    expect(batch.count()).toBe(3);
  });
});
