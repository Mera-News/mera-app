// The wait line's phase signal (`onPhase`). It is a callback on the request, never an SseEvent, and
// every phase is pinned to a real point in the request's life against the real stack: the real
// attestation cache, the real interactive limiter, the real gateway mock. No module is mocked.
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { fetchModelPublicKey } from '@/lib/e2ee/e2ee-service';
import { SMALL_MODEL } from '@/lib/llm/constants';
import { useChatPhaseStore } from '@/lib/llm/chat-phase-store';
import { cloudChatStream } from '@/lib/llm/cloudComplete';
import { _resetForTests as resetLimiter, interactiveWaitMs } from '@/lib/llm/gateway-rate-limiter';
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import { useStrictClock } from '@/test/integration/chat/_helpers';
import {
  captureChatBodies,
  collect,
  drive,
  installChatHooks,
  MESSAGES,
  respond,
  textOf,
  until,
} from './support';

installChatHooks();

const DECRYPT_400 = { status: 400, body: { error: `Provider failed for model '${SMALL_MODEL}': Decryption failed` } };

function watch(extra: object = {}) {
  const seen: string[] = [];
  const start = () =>
    collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL, onPhase: (p) => seen.push(String(p)), ...extra }));
  return { seen, start };
}

/** A warm attestation cache with an idle limiter, as the tenth message of a session sees it. */
async function warm() {
  await fetchModelPublicKey(SMALL_MODEL, 'interactive');
  resetLimiter();
}

describe('the opening phases', () => {
  it('a warm attestation cache walks reset, securing, thinking: never attesting, queued or retrying', async () => {
    server.use(...mockGateway(respond('ok')));
    await warm();
    const { seen, start } = watch();
    await start();
    expect(seen).toEqual(['reset', 'securing', 'thinking']);
  });

  it('a cold cache says attesting instead, which is what the first send of a launch pays', async () => {
    server.use(...mockGateway(respond('ok')));
    clearAttestationCache();
    const { seen, start } = watch();
    await start();
    expect(seen).toEqual(['reset', 'attesting', 'thinking']);
  });

  it('thinking is not reported before the response resolves', async () => {
    // A held response, not a clock: if phases were buffered and flushed at the end, `securing` would be
    // missing here and `thinking` present, and both halves of this would flip together.
    server.use(...mockGateway(respond({ chunks: ['ok'], headerDelayMs: 2000 })));
    await warm();
    const { seen, start } = watch();
    const done = start();
    await until(() => gatewayCalls('chat').length === 1);
    expect(seen).toEqual(['reset', 'securing']);
    await done;
    expect(seen).toEqual(['reset', 'securing', 'thinking']);
  });

  it('thinking is reported even though the stream carries no reasoning at all', async () => {
    // The persona loop sends enable_thinking false on every leg; gating the phase on a reasoning
    // event would leave the longest window of the wait unnarrated.
    server.use(...mockGateway(respond('ok')));
    await warm();
    const { seen, start } = watch({ enableThinking: false });
    const events = await start();
    expect(events.some((e) => e.type === 'reasoning')).toBe(false);
    expect(seen).toContain('thinking');
  });
});

describe('queued', () => {
  it('is reported, ahead of securing, only when the interactive lane really has to wait', async () => {
    useStrictClock('2026-10-09T00:00:00Z');
    server.use(...mockGateway(respond('ok')));
    await drive(fetchModelPublicKey(SMALL_MODEL, 'interactive'));
    resetLimiter();
    // Two calls back to back: the first spends the grant, the second finds the lane 1s out.
    await drive(collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL })));
    expect(interactiveWaitMs()).toBeGreaterThan(400);

    const { seen, start } = watch();
    await drive(start());
    expect(seen).toEqual(['reset', 'queued', 'securing', 'thinking']);
  });

  it('is not reported for a wait too short to read', async () => {
    useStrictClock('2026-10-09T00:00:00Z');
    server.use(...mockGateway(respond('ok')));
    await drive(fetchModelPublicKey(SMALL_MODEL, 'interactive'));
    resetLimiter();
    await drive(collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL })));
    while (interactiveWaitMs() > 300) await jest.advanceTimersByTimeAsync(50);
    // The precondition that makes this test discriminate: there IS a wait, and it is short.
    expect(interactiveWaitMs()).toBeGreaterThan(0);

    const { seen, start } = watch();
    await drive(start());
    expect(seen).not.toContain('queued');
    expect(seen).toEqual(['reset', 'securing', 'thinking']);
  });
});

describe('retrying: any re-entry into the request builder', () => {
  it('a decrypt-failure re-attest says retrying, never securing a second time', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? DECRYPT_400 : 'ok')));
    await warm();
    const { seen, start } = watch();
    await start();
    expect(gatewayCalls('chat')).toHaveLength(2);
    // `thinking` is not reported again after a retry: it ranks below `retrying`, so it could not render.
    expect(seen).toEqual(['reset', 'securing', 'retrying']);
  });

  it('the hedge leg says retrying, and the ordinary thinking line is not walked back to afterwards', async () => {
    useStrictClock('2026-10-09T00:00:00Z');
    server.use(...mockGateway((c) => (c.index === 0 ? { chunks: ['slow'], headerDelayMs: 60_000 } : 'fast')));
    await drive(fetchModelPublicKey(SMALL_MODEL, 'interactive'));
    resetLimiter();
    const { seen, start } = watch();
    const events = await drive(start());
    expect(textOf(events)).toBe('fast');
    expect(gatewayCalls('chat')).toHaveLength(2);
    // A hedge built up front would have said `retrying` at t=0 on every call; it builds behind its timer.
    expect(seen).toEqual(['reset', 'securing', 'retrying', 'thinking']);
  });

  it('a stream-death retry says retrying after the first thinking', async () => {
    server.use(...mockGateway((c) => (c.index === 0 ? { chunks: ['never seen'], closeAfter: 0 } : 'ok')));
    await warm();
    const { seen, start } = watch();
    await start();
    expect(gatewayCalls('chat')).toHaveLength(2);
    expect(seen).toEqual(['reset', 'securing', 'thinking', 'retrying']);
  });

  it('every call opens with a reset, so each agent leg re-walks its phases', async () => {
    server.use(...mockGateway(respond('ok')));
    await warm();
    const { seen, start } = watch();
    await start();
    await start();
    expect(seen.filter((p) => p === 'reset')).toHaveLength(2);
    expect(seen[0]).toBe('reset');
    expect(seen.indexOf('reset', 1)).toBeGreaterThan(seen.indexOf('thinking'));
  });
});

describe('without a caller asking', () => {
  it('nothing is published to the chat phase store, with or without onPhase', async () => {
    const bodies = captureChatBodies();
    server.use(...mockGateway(respond('ok')));
    const idle = { kind: 'idle' };
    expect(useChatPhaseStore.getState().view).toEqual(idle);

    const events = await collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL }));
    expect(textOf(events)).toBe('ok');
    expect(useChatPhaseStore.getState().view).toEqual(idle);

    // The callback is per request: even a caller that passes one does not reach the store.
    await watch().start();
    expect(useChatPhaseStore.getState().view).toEqual(idle);
    for (const b of bodies) expect(b).not.toContain('SENTINEL');
  });
});
