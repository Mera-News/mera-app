// cloudBatchComplete against the gateway mock: per-item sealing, results mapped back by index, the
// thinking flag per call, per-item and whole-request failures. Replies the responder cannot express
// (an out-of-order batch, a per-item error, a reasoning-only item) replace the batch route with
// serveJson, sealed toward the calling client with its real key.
import { MODEL_FALLBACKS, SMALL_MODEL } from '@/lib/llm/constants';
import * as e2eeService from '@/lib/e2ee/e2ee-service';
import { cloudBatchComplete } from '@/lib/llm/cloudComplete';
import type { BatchCall } from '@/lib/llm/types';
import { attestationRequests, gatewayCalls, mockGateway, server, signInFixtureAccount } from '@/test/helpers';
import {
  BATCH_PATH,
  errorOf,
  fakeClock,
  resetTransport,
  respond,
  run,
  serveJson,
  watchRequests,
} from './transport-kit';

const SECRET = 'SENTINEL-BATCH-a91f';
const call = (id: string, extras: Partial<BatchCall> = {}): BatchCall => ({
  id,
  system: `system-${id}`,
  prompt: `prompt-${id} ${SECRET}`,
  temperature: 0.3,
  ...extras,
});
const item = (index: number, content: string, extra: object = {}) => ({
  index,
  response: { choices: [{ message: { content, ...extra }, finish_reason: 'stop' }] },
});

beforeEach(async () => {
  await resetTransport({ signIn: false });
});

afterEach(() => {
  server.events.removeAllListeners();
});

describe('cloudBatchComplete', () => {
  beforeEach(async () => {
    await signInFixtureAccount();
    fakeClock();
  });

  it('sends nothing for an empty list', async () => {
    const batch = watchRequests(BATCH_PATH);

    expect(await run(cloudBatchComplete([]))).toEqual([]);

    expect(batch.count()).toBe(0);
    expect(attestationRequests()).toBe(0);
  });

  it('seals every item separately and maps the replies back by call id, in order', async () => {
    server.use(...mockGateway((c) => `echo:${c.messages[1].content}`));
    const batch = watchRequests(BATCH_PATH);

    const out = await run(cloudBatchComplete([call('a'), call('b'), call('c')]));

    expect(out).toEqual([
      { id: 'a', output: `echo:prompt-a ${SECRET}` },
      { id: 'b', output: `echo:prompt-b ${SECRET}` },
      { id: 'c', output: `echo:prompt-c ${SECRET}` },
    ]);
    expect(gatewayCalls('batch').map((c) => c.messages.map((m) => m.content))).toEqual([
      ['system-a', `prompt-a ${SECRET}`],
      ['system-b', `prompt-b ${SECRET}`],
      ['system-c', `prompt-c ${SECRET}`],
    ]);
    expect(await batch.raw()).toHaveLength(1);
    expect((await batch.raw())[0]).not.toContain('SENTINEL');
  });

  it('maps results by index when they arrive out of order', async () => {
    serveJson(BATCH_PATH, (seal) => ({ results: [item(1, seal('r-y')), item(0, seal('r-x'))] }));

    const out = await run(cloudBatchComplete([call('x'), call('y')]));

    expect(out).toEqual([
      { id: 'x', output: 'r-x' },
      { id: 'y', output: 'r-y' },
    ]);
  });

  it('reports a server-side item error against its own id and keeps the others', async () => {
    serveJson(BATCH_PATH, (seal) => ({
      results: [{ index: 0, error: { message: 'Model overloaded' } }, item(1, seal('good'))],
    }));

    const out = await run(cloudBatchComplete([call('e1'), call('e2')]));

    expect(out).toEqual([
      { id: 'e1', output: '', error: 'Model overloaded' },
      { id: 'e2', output: 'good' },
    ]);
  });

  it('reports a missing result when an index is absent from the reply', async () => {
    serveJson(BATCH_PATH, (seal) => ({ results: [item(1, seal('x'))] }));

    const out = await run(cloudBatchComplete([call('m1'), call('m2')]));

    expect(out).toEqual([
      { id: 'm1', output: '', error: 'Missing result from batch' },
      { id: 'm2', output: 'x' },
    ]);
  });

  it('returns an empty output with no error field when the model said nothing', async () => {
    serveJson(BATCH_PATH, () => ({ results: [item(0, '')] }));

    const [result] = await run(cloudBatchComplete([call('empty')]));

    expect(result).toEqual({ id: 'empty', output: '' });
    expect(result.error).toBeUndefined();
  });

  it('returns an empty output when a sealed reply decrypts to the empty string', async () => {
    server.use(...mockGateway(respond('')));

    expect(await run(cloudBatchComplete([call('empty-decrypt')]))).toEqual([{ id: 'empty-decrypt', output: '' }]);
  });

  it('reports a decrypt failure on that item alone', async () => {
    serveJson(BATCH_PATH, (seal) => ({ results: [item(0, 'not-a-valid-envelope'), item(1, seal('fine'))] }));

    const [broken, fine] = await run(cloudBatchComplete([call('fail'), call('ok')]));

    expect(broken.output).toBe('');
    expect(broken.error).toEqual(expect.any(String));
    expect(broken.error).not.toBe('');
    expect(fine).toEqual({ id: 'ok', output: 'fine' });
  });

  it('names a non-Error decrypt failure generically', async () => {
    // Real crypto only throws Errors; one throw of a bare string is injected on one call (R23).
    const decrypt = jest.spyOn(e2eeService, 'decryptContent').mockImplementationOnce(() => {
      throw 'string error';
    });
    server.use(...mockGateway(respond('blob')));

    const [result] = await run(cloudBatchComplete([call('fail2')]));

    decrypt.mockRestore();
    expect(result).toEqual({ id: 'fail2', output: '', error: 'Decrypt error' });
  });

  // A trace that exhausts max_tokens leaves content empty. Handing the trace back as the answer
  // made a pure budget problem look like a benign empty reply; an error is retryable and countable.
  it('errors instead of substituting reasoning_content for an empty content', async () => {
    serveJson(BATCH_PATH, (seal) => ({
      results: [item(0, '', { reasoning_content: seal('a long chain of thought') })],
    }));

    const [result] = await run(cloudBatchComplete([call('reasoning')]));

    expect(result).toEqual({ id: 'reasoning', output: '', error: 'reasoning-overran-budget' });
  });

  it('returns the content normally when BOTH content and reasoning are present', async () => {
    server.use(...mockGateway(respond({ chunks: ['["a"]'], reasoning: true })));

    const [result] = await run(cloudBatchComplete([call('both')]));

    expect(result).toEqual({ id: 'both', output: '["a"]' });
  });

  describe('the thinking flag', () => {
    const flagsOf = async (calls: BatchCall[]) => {
      const batch = watchRequests(BATCH_PATH);
      await run(cloudBatchComplete(calls));
      const [body] = await batch.json();
      return body.requests.map((r: { chat_template_kwargs: { enable_thinking: boolean } }) => r.chat_template_kwargs.enable_thinking);
    };

    it('defaults to false when the call omits it', async () => {
      expect(await flagsOf([call('no-flag')])).toEqual([false]);
    });

    it('is false when explicitly false and true when explicitly true', async () => {
      expect(await flagsOf([call('off', { enableThinking: false })])).toEqual([false]);
      expect(await flagsOf([call('on', { enableThinking: true })])).toEqual([true]);
    });

    it('is set per call, not per batch', async () => {
      expect(await flagsOf([call('a', { enableThinking: true }), call('b')])).toEqual([true, false]);
    });
  });

  describe('the request body', () => {
    it('uses the model it is given', async () => {
      await run(cloudBatchComplete([call('x')], 'my-custom-model'));
      expect(gatewayCalls('batch')[0].model).toBe('my-custom-model');
    });

    it('defaults to SMALL_MODEL', async () => {
      await run(cloudBatchComplete([call('x')]));
      expect(gatewayCalls('batch')[0].model).toBe(SMALL_MODEL);
    });

    it.each([
      ['includes max_tokens when the call sets it', 512],
      ['omits max_tokens when the call does not', undefined],
    ])('%s', async (_label, maxTokens) => {
      const batch = watchRequests(BATCH_PATH);

      await run(cloudBatchComplete([call('mt', { maxTokens })]));

      expect((await batch.json())[0].requests[0].max_tokens).toBe(maxTokens);
    });

    it('seals non-empty content and leaves an empty string empty', async () => {
      const batch = watchRequests(BATCH_PATH);

      await run(cloudBatchComplete([{ id: 'empty-sys', system: '', prompt: SECRET, temperature: 0.3 }]));

      const [{ requests }] = await batch.json();
      expect(requests[0].messages[0]).toEqual({ role: 'system', content: '' });
      expect(requests[0].messages[1].content).not.toContain('SENTINEL');
      expect(gatewayCalls('batch')[0].messages).toEqual([
        { role: 'system', content: '' },
        { role: 'user', content: SECRET },
      ]);
    });
  });

  describe('whole-request failures', () => {
    it('throws on a non-ok reply and does not retry a 4xx', async () => {
      server.use(...mockGateway(respond({ status: 400, body: 'Bad Request' })));
      const batch = watchRequests(BATCH_PATH);

      const err = await run(errorOf(cloudBatchComplete([call('err')])));

      expect(err?.message).toMatch(/E2EE batch failed: 400/);
      expect(batch.count()).toBe(1);
    });

    // CH17: same shape as cloudComplete: the status is only in the message text.
    const NON_OK = [401, 503] as const;
    const failWith = async (status: number) => {
      server.use(...mockGateway(respond({ status, body: 'gateway said no' })));
      const err = await run(errorOf(cloudBatchComplete([call('err')])));
      expect(err).toBeInstanceOf(Error);
      return err as Error & { statusCode?: number };
    };

    it('CH17: a non-ok completion carries its status as a field', async () => {
      for (const status of NON_OK) {
        const err = await failWith(status);
        expect(err.statusCode).toBe(status);
        expect(err.message).toMatch(new RegExp(`E2EE batch failed: ${status}`));
      }
    });

    it('moves a stalled primary onto the fallback model for the retry and for later batches', async () => {
      server.use(...mockGateway((c) => (c.model === SMALL_MODEL ? { status: 502 } : 'recovered')));

      const first = await run(cloudBatchComplete([call('c1')]));
      const second = await run(cloudBatchComplete([call('c2')]));

      expect(first).toEqual([{ id: 'c1', output: 'recovered' }]);
      expect(second).toEqual([{ id: 'c2', output: 'recovered' }]);
      expect(gatewayCalls('batch').map((c) => c.model)).toEqual([
        SMALL_MODEL,
        SMALL_MODEL,
        MODEL_FALLBACKS[SMALL_MODEL],
        MODEL_FALLBACKS[SMALL_MODEL],
      ]);
    });
  });
});

describe('cloudBatchComplete signed out', () => {
  beforeEach(fakeClock);

  it('fails before anything is sent when there is no credential', async () => {
    const batch = watchRequests(BATCH_PATH);

    const err = await run(errorOf(cloudBatchComplete([call('x')])));

    expect(err).toBeInstanceOf(Error);
    expect(batch.count()).toBe(0);
    expect(gatewayCalls()).toEqual([]);
  });
});
