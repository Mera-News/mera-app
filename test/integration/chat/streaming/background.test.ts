// A chat leg across the app leaving. iOS suspends JS within seconds, so the socket dies or hangs and
// every overdue timer lands on return. The rule under test: the time away is never model evidence,
// the reply comes from the turn store when the gateway kept it, and otherwise the leg is re-sent
// once, with `restart` clearing what was shown so nothing renders twice.
import { http, HttpResponse } from 'msw';
import { MODEL_FALLBACKS, SMALL_MODEL } from '@/lib/llm/constants';
import {
  BUFFERED_HEDGE_DELAY_MS,
  cloudChatStream,
  cloudComplete,
  HEDGE_DELAY_MS,
  STREAM_IDLE_TIMEOUT_MS,
  UPSTREAM_ALIGNED_TIMEOUT_MS,
  type SseEvent,
} from '@/lib/llm/cloudComplete';
import { isFallbackEngaged } from '@/lib/llm/model-fallback';
import { gatewayCalls, mockGateway, server, setAppState } from '@/test/helpers';
import { useStrictClock } from '@/test/integration/chat/_helpers';
import {
  advanceUntil,
  delta,
  detachedGateway,
  DONE,
  drive,
  installChatHooks,
  MESSAGES,
  shownText,
  textOf,
} from './support';

installChatHooks();

const FALLBACK = MODEL_FALLBACKS[SMALL_MODEL];
const ID = /^[A-Za-z0-9_-]{16,64}$/;

/** Reads events as they arrive, so a test can act between two of them. */
function pump(extra: object = {}) {
  const events: SseEvent[] = [];
  const done = (async () => {
    for await (const e of cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, ...extra })) events.push(e);
    return events;
  })();
  return { events, done };
}
const fail = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);
const away = () => setAppState('background');
/** iOS: JS stops, the wall clock goes on, and every timer comes due late on return. */
async function suspendFor(ms: number): Promise<void> {
  away();
  jest.setSystemTime(Date.now() + ms);
  await jest.advanceTimersByTimeAsync(ms);
}
const sentHeaders = () => gatewayCalls('chat').map((c) => c.headers['x-mera-turn-id']);

beforeEach(() => {
  useStrictClock('2026-11-04T00:00:00Z');
  setAppState('active');
});
afterEach(() => setAppState('active'));

describe('the turn id', () => {
  it('every chat attempt carries a fresh valid id, and a 502 retry gets a new one', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? { status: 502, body: 'cold' } : 'hello')));
    const { done } = pump();
    expect(textOf(await drive(done))).toBe('hello');
    const ids = sentHeaders();
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(ID);
    expect(new Set(ids).size).toBe(2);
  });

  it('a buffered leg carries one too, and a scoring call does not', async () => {
    server.use(...mockGateway(() => 'hello'));
    await drive(pump({ stream: false }).done);
    await drive(cloudComplete({ systemPrompt: 's', prompt: 'p' }));
    const [leg, scoring] = sentHeaders();
    expect(leg).toMatch(ID);
    expect(scoring).toBeUndefined();
  });
});

describe('flag off: every read answers turn-gone', () => {
  it('before the first delta: no attempt leaves while away, one re-send on return, no verdict, no restart', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? { chunks: ['x'], stallAfter: 0 } : 'hello')));
    const { events, done } = pump();
    await advanceUntil(() => gatewayCalls('chat').length === 1);

    setAppState('background');
    await jest.advanceTimersByTimeAsync(200_000);
    expect(gatewayCalls('chat')).toHaveLength(1);

    setAppState('active');
    await drive(done);
    expect(gatewayCalls('chat')).toHaveLength(2);
    expect(textOf(events)).toBe('hello');
    expect(events.some((e) => e.type === 'restart')).toBe(false);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });

  it('mid-stream: the partial is cleared by `restart` and the text lands once', async () => {
    server.use(
      ...mockGateway((c) => (c.index === 0 ? { chunks: ['Par', 'tial'], stallAfter: 1 } : 'Whole answer')),
    );
    const { events, done } = pump();
    await advanceUntil(() => textOf(events) === 'Par');

    setAppState('background');
    await jest.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 1000);
    setAppState('active');
    await drive(done);

    expect(events.filter((e) => e.type === 'restart')).toHaveLength(1);
    expect(shownText(events)).toBe('Whole answer');
    expect(gatewayCalls('chat')).toHaveLength(2);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });

  it('a stream that closes while away is re-sent, where in the foreground it would surface', async () => {
    server.use(
      ...mockGateway((c) => (c.index === 0 ? { chunks: ['Par', 'tial'], closeAfter: 1, chunkDelayMs: 5000 } : 'Whole')),
    );
    const { events, done } = pump();
    await advanceUntil(() => textOf(events) === 'Par');
    away();
    await jest.advanceTimersByTimeAsync(6000);
    setAppState('active');
    await drive(done);
    expect(shownText(events)).toBe('Whole');
  });

  it('an overdue hedge timer after a departure fires no hedge and engages nothing', async () => {
    server.use(
      ...mockGateway((c) =>
        c.index === 0 && c.model === SMALL_MODEL ? { chunks: ['late'], headerDelayMs: 300_000 } : 'hello',
      ),
    );
    const { events, done } = pump();
    await advanceUntil(() => gatewayCalls('chat').length === 1);

    await suspendFor(HEDGE_DELAY_MS + 5000);
    setAppState('active');
    await drive(done);

    expect(textOf(events)).toBe('hello');
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([SMALL_MODEL, SMALL_MODEL]);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });

  it('a second away inside the hedge window is no departure: the hedge fires on time, the primary is not cut, and no verdict lands', async () => {
    server.use(
      ...mockGateway((c) => (c.model === SMALL_MODEL ? { chunks: ['slow'], headerDelayMs: 60_000 } : 'fast')),
    );
    const { events, done } = pump();
    await advanceUntil(() => gatewayCalls('chat').length === 1);
    away();
    await jest.advanceTimersByTimeAsync(1000);
    setAppState('active');
    await drive(done);

    expect(textOf(events)).toBe('fast');
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([SMALL_MODEL, FALLBACK]);
    expect(events.some((e) => e.type === 'restart')).toBe(false);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });

  it('a leg that starts while away waits for the return', async () => {
    server.use(...mockGateway(() => 'hello'));
    setAppState('background');
    const { events, done } = pump();
    await jest.advanceTimersByTimeAsync(5000);
    expect(gatewayCalls('chat')).toHaveLength(0);
    setAppState('active');
    await drive(done);
    expect(textOf(events)).toBe('hello');
  });

  it('Stop while waiting for the return ends the leg at once', async () => {
    server.use(...mockGateway(() => 'hello'));
    setAppState('background');
    const stop = new AbortController();
    const { done } = pump({ signal: stop.signal });
    await jest.advanceTimersByTimeAsync(100);
    stop.abort();
    const err = await drive(fail(done));
    expect(err?.name).toBe('CallerAbortError');
    expect(gatewayCalls('chat')).toHaveLength(0);
  });

  it('a second failure after the re-send surfaces: the leg is re-sent once', async () => {
    server.use(...mockGateway(() => ({ chunks: ['x'], stallAfter: 0 })));
    const { done } = pump();
    const outcome = fail(done);
    await advanceUntil(() => gatewayCalls('chat').length === 1);
    setAppState('background');
    await jest.advanceTimersByTimeAsync(200_000);
    setAppState('active');
    await advanceUntil(() => gatewayCalls('chat').length === 2);
    setAppState('background');
    await jest.advanceTimersByTimeAsync(200_000);
    setAppState('active');
    expect(await drive(outcome)).toBeInstanceOf(Error);
    expect(gatewayCalls('chat')).toHaveLength(2);
  });

  it('with no departure a stall keeps today\'s path, verdict included', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? { chunks: ['x'], stallAfter: 0 } : 'hello')));
    const { events, done } = pump();
    await advanceUntil(() => gatewayCalls('chat').length === 1);
    await jest.advanceTimersByTimeAsync(UPSTREAM_ALIGNED_TIMEOUT_MS + 1000);
    await drive(done);
    expect(textOf(events)).toBe('hello');
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(true);
  });
});

describe('flag on: the turn store holds the reply', () => {
  it('mid-stream: resumes from the byte cursor through a frame cut in half, with no second POST', async () => {
    const whole = (seal: (t: string) => string) =>
      delta({ content: seal('Hello ') }) + delta({ content: seal('wor') }) + delta({ content: seal('ld') }, 'stop') + DONE;
    let liveBytes = 0;
    const gw = detachedGateway((seal) => {
      const stored = whole(seal);
      const firstFrameEnd = stored.indexOf('\n\n') + 2;
      const cut = firstFrameEnd + 20;
      liveBytes = cut;
      return {
        stored,
        live: [stored.slice(0, firstFrameEnd), stored.slice(firstFrameEnd, cut), { wait: 5000 }, { fail: new Error('socket lost') }],
        polls: [{ upTo: cut + 5, status: 'running' }, { status: 'done' }],
      };
    });
    server.use(...gw.handlers);
    const { events, done } = pump();
    await advanceUntil(() => textOf(events) === 'Hello ');
    away();
    await jest.advanceTimersByTimeAsync(6000);
    setAppState('active');
    await drive(done);

    expect(textOf(events)).toBe('Hello world');
    expect(events.some((e) => e.type === 'restart')).toBe(false);
    expect(gw.ids).toHaveLength(1);
    expect(gw.reads[0]).toEqual({ id: gw.ids[0], after: liveBytes });
    expect(gw.reads[1].after).toBe(liveBytes + 5);
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('before any byte: reads the stream from 0', async () => {
    const gw = detachedGateway((seal) => ({ hold: true, stored: delta({ content: seal('From the store') }) + DONE }));
    server.use(...gw.handlers);
    const { events, done } = pump();
    await advanceUntil(() => gw.ids.length === 1);
    await suspendFor(HEDGE_DELAY_MS + 5000);
    setAppState('active');
    await drive(done);
    expect(textOf(events)).toBe('From the store');
    expect(gw.ids).toHaveLength(1);
    expect(gw.reads[0].after).toBe(0);
  });

  it('a buffered leg resumes by reading the stored JSON', async () => {
    const gw = detachedGateway((seal) => ({
      hold: true,
      stored: JSON.stringify({ choices: [{ message: { content: seal('Buffered answer') }, finish_reason: 'stop' }] }),
      polls: [{ status: 'running', upTo: 0 }, {}],
    }));
    server.use(...gw.handlers);
    const { events, done } = pump({ stream: false });
    await advanceUntil(() => gw.ids.length === 1);
    await suspendFor(BUFFERED_HEDGE_DELAY_MS + 5000);
    setAppState('active');
    await drive(done);
    expect(textOf(events)).toBe('Buffered answer');
    expect(gw.ids).toHaveLength(1);
  });

  it.each([
    ['error', { status: 'error' as const }],
    ['cancelled', { status: 'cancelled' as const }],
    ['an upstream non-2xx', { status: 'done' as const, upTo: 0, upstream: 500 }],
    ['turn-gone', { fail: { status: 404, code: 'turn-gone' } }],
  ])('falls back to one re-send on %s, clearing the partial', async (_name, poll) => {
    const gw = detachedGateway((seal, attempt) =>
      attempt === 0
        ? {
            stored: delta({ content: seal('Par') }) + delta({ content: seal('tial') }),
            live: [delta({ content: seal('Par') }), { wait: 5000 }, { fail: new Error('socket lost') }],
            polls: [poll],
          }
        : { stored: '', live: [delta({ content: seal('Whole') }, 'stop'), DONE] },
    );
    server.use(...gw.handlers);
    const { events, done } = pump();
    await advanceUntil(() => textOf(events) === 'Par');
    away();
    await jest.advanceTimersByTimeAsync(6000);
    setAppState('active');
    await drive(done);

    expect(shownText(events)).toBe('Whole');
    expect(gw.ids).toHaveLength(2);
    expect(isFallbackEngaged(SMALL_MODEL)).toBe(false);
  });

  it('retries a 503 turn-store-unavailable', async () => {
    const gw = detachedGateway((seal) => ({
      hold: true,
      stored: delta({ content: seal('Stored') }) + DONE,
      polls: [{ fail: { status: 503, code: 'turn-store-unavailable' } }, {}],
    }));
    server.use(...gw.handlers);
    const { events, done } = pump();
    await advanceUntil(() => gw.ids.length === 1);
    await suspendFor(HEDGE_DELAY_MS + 5000);
    setAppState('active');
    await drive(done);
    expect(textOf(events)).toBe('Stored');
    expect(gw.ids).toHaveLength(1);
  });

  it('a poll that stays silent past the idle window falls back to the re-send and drops the old turn', async () => {
    const gw = detachedGateway((seal, attempt) =>
      attempt === 0
        ? {
            stored: delta({ content: seal('Par') }),
            live: [delta({ content: seal('Par') }), { wait: 5000 }, { fail: new Error('socket lost') }],
            polls: [{ status: 'running' }],
          }
        : { stored: '', live: [delta({ content: seal('Whole') }, 'stop'), DONE] },
    );
    server.use(...gw.handlers);
    const { events, done } = pump();
    await advanceUntil(() => textOf(events) === 'Par');
    away();
    await jest.advanceTimersByTimeAsync(6000);
    setAppState('active');
    await drive(done);

    expect(shownText(events)).toBe('Whole');
    await advanceUntil(() => gw.deletes.includes(gw.ids[0]));
    const after = gw.reads.filter((r) => r.id === gw.ids[0]);
    for (let i = 1; i < after.length; i++) expect(after[i].after).toBe(after[0].after);
  });

  it('a hanging network ends the poll inside the budget, where counting only the sleeps took minutes', async () => {
    const gw = detachedGateway((seal, attempt) =>
      attempt === 0
        ? { hold: true, stored: '', polls: [{ hang: true }] }
        : { stored: '', live: [delta({ content: seal('Whole') }, 'stop'), DONE] },
    );
    server.use(...gw.handlers);
    const { events, done } = pump();
    await advanceUntil(() => gw.ids.length === 1);
    await suspendFor(HEDGE_DELAY_MS + 5000);
    const back = Date.now();
    setAppState('active');
    await advanceUntil(() => gw.ids.length === 2, 200_000);

    expect(Date.now() - back).toBeLessThan(UPSTREAM_ALIGNED_TIMEOUT_MS + 30_000);
    await drive(done);
    expect(textOf(events)).toBe('Whole');
  });

  it('time away during a poll does not count against its budget', async () => {
    const running = { status: 'running' as const, upTo: 0 };
    const gw = detachedGateway((seal) => ({
      hold: true,
      stored: delta({ content: seal('Stored') }) + DONE,
      polls: [running, running, {}],
    }));
    server.use(...gw.handlers);
    const { events, done } = pump();
    await advanceUntil(() => gw.ids.length === 1);
    await suspendFor(HEDGE_DELAY_MS + 5000);
    setAppState('active');
    await advanceUntil(() => gw.reads.length === 1);
    await suspendFor(UPSTREAM_ALIGNED_TIMEOUT_MS + 60_000);
    setAppState('active');
    await drive(done);

    expect(textOf(events)).toBe('Stored');
    expect(gw.ids).toHaveLength(1);
  });

  it('polls no faster than once a second', async () => {
    const stamps: number[] = [];
    const gw = detachedGateway((seal) => ({
      hold: true,
      stored: delta({ content: seal('Slow') }) + DONE,
      polls: [{ status: 'running', upTo: 0 }, { status: 'running', upTo: 0 }, { status: 'running', upTo: 0 }, {}],
    }));
    server.use(...gw.handlers);
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'GET' && request.url.includes('/v1/chat/turns/')) stamps.push(Date.now());
    });
    const { done } = pump();
    await advanceUntil(() => gw.ids.length === 1);
    await suspendFor(HEDGE_DELAY_MS + 5000);
    setAppState('active');
    await drive(done);
    expect(stamps.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i] - stamps[i - 1]).toBeGreaterThanOrEqual(1000);
  });
});

describe('best-effort DELETE', () => {
  it('Stop deletes the turn in flight', async () => {
    const gw = detachedGateway((seal) => ({
      stored: '',
      live: [delta({ content: seal('Par') }), { wait: 60_000 }],
    }));
    server.use(...gw.handlers);
    const stop = new AbortController();
    const { events, done } = pump({ signal: stop.signal });
    await advanceUntil(() => textOf(events) === 'Par');
    stop.abort();
    await drive(fail(done));
    await advanceUntil(() => gw.deletes.length === 1);
    expect(gw.deletes).toEqual([gw.ids[0]]);
  });

  it('a losing hedge leg is deleted, and a failing DELETE changes nothing', async () => {
    const posts: string[] = [];
    const deletes: string[] = [];
    server.use(
      http.delete('*/v1/chat/turns/:id', ({ params }) => {
        deletes.push(String(params.id));
        return HttpResponse.json({ code: 'turn-store-unavailable' }, { status: 503 });
      }),
      ...mockGateway((c) => {
        posts.push(c.headers['x-mera-turn-id']);
        return c.model === SMALL_MODEL ? { chunks: ['slow'], headerDelayMs: 60_000 } : 'fast';
      }),
    );
    const { events, done } = pump();
    await drive(done);
    await advanceUntil(() => deletes.length >= 1);
    expect(textOf(events)).toBe('fast');
    expect(deletes[0]).toBe(posts[0]);
    expect(gatewayCalls('chat').map((c) => c.model)).toEqual([SMALL_MODEL, FALLBACK]);
  });

  it('a finished turn is left alone', async () => {
    const gw = detachedGateway((seal) => ({ stored: '', live: [delta({ content: seal('Done') }, 'stop'), DONE] }));
    server.use(...gw.handlers);
    await drive(pump().done);
    await jest.advanceTimersByTimeAsync(5000);
    expect(gw.deletes).toHaveLength(0);
  });
});

