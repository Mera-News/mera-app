import {
  CHAT_PHASE_IDS,
  CLOUD_PHASE_ORDER,
  DEVICE_PHASE_ORDER,
  chatPhaseIndex,
  makePhaseSink,
  resolveChatPhase,
  type ChatPhaseId,
} from '../chat-phase';

describe('chat-phase orders', () => {
  it('the two engine orders are disjoint and together are the whole id set', () => {
    const cloud = new Set<string>(CLOUD_PHASE_ORDER);
    const device = new Set<string>(DEVICE_PHASE_ORDER);
    expect([...cloud].filter((id) => device.has(id))).toEqual([]);
    expect([...CHAT_PHASE_IDS].sort()).toEqual([...cloud, ...device].sort());
  });

  it('ranks every id inside its OWN engine, starting at 0 for both', () => {
    expect(chatPhaseIndex('preparing')).toBe(0);
    expect(chatPhaseIndex('deviceLoading')).toBe(0);
    for (const order of [CLOUD_PHASE_ORDER, DEVICE_PHASE_ORDER]) {
      order.forEach((id, i) => expect(chatPhaseIndex(id)).toBe(i));
    }
  });

  it('ranks an unknown id -1 rather than 0, so it cannot masquerade as the opener', () => {
    expect(chatPhaseIndex('nope' as ChatPhaseId)).toBe(-1);
  });

  it('keeps `retrying` above every phase a model call publishes', () => {
    // A hedge or a stream retry re-enters the request builder. If `retrying`
    // outranked nothing, the builder's own `securing` would win and walk the
    // reader back to "encrypting" at the longest point of the wait.
    const retrying = CLOUD_PHASE_ORDER.indexOf('retrying');
    for (const id of ['preparing', 'queued', 'securing', 'attesting', 'thinking'] as const) {
      expect(CLOUD_PHASE_ORDER.indexOf(id)).toBeLessThan(retrying);
    }
  });

  it('puts `webSearch` last: it runs BETWEEN model calls (ux2 D10)', () => {
    // Published by the device port after the leg that asked for it, so it must
    // outrank whatever that leg showed; the next call's 'reset' clears it.
    expect(CLOUD_PHASE_ORDER[CLOUD_PHASE_ORDER.length - 1]).toBe('webSearch');
  });
});

describe('resolveChatPhase', () => {
  it('takes any signal when there is no mark', () => {
    for (const id of CHAT_PHASE_IDS) {
      expect(resolveChatPhase({ signal: id, previousPhase: null })).toBe(id);
    }
  });

  // EXHAUSTIVE over every ordered pair, not sampled: reordering either array
  // has to break this immediately.
  it.each([
    ['cloud', CLOUD_PHASE_ORDER] as const,
    ['device', DEVICE_PHASE_ORDER] as const,
  ])('never walks backwards within the %s order', (_name, order) => {
    for (let hi = 0; hi < order.length; hi++) {
      for (let lo = 0; lo < hi; lo++) {
        expect(resolveChatPhase({ signal: order[lo], previousPhase: order[hi] })).toBe(order[hi]);
      }
    }
  });

  it.each([
    ['cloud', CLOUD_PHASE_ORDER] as const,
    ['device', DEVICE_PHASE_ORDER] as const,
  ])('advances forwards within the %s order', (_name, order) => {
    for (let lo = 0; lo < order.length; lo++) {
      for (let hi = lo + 1; hi < order.length; hi++) {
        expect(resolveChatPhase({ signal: order[hi], previousPhase: order[lo] })).toBe(order[hi]);
      }
    }
  });

  it('holds on a repeat', () => {
    expect(resolveChatPhase({ signal: 'securing', previousPhase: 'securing' })).toBe('securing');
  });

  it('refuses a cross-engine signal outright rather than comparing ranks', () => {
    // `deviceThinking` is rank 2 and `thinking` is rank 4. Compared on a shared
    // scale the device id would lose here and WIN against `preparing`, which
    // is how a cloud turn ends up narrating "on your phone".
    expect(resolveChatPhase({ signal: 'deviceThinking', previousPhase: 'thinking' })).toBe('thinking');
    expect(resolveChatPhase({ signal: 'deviceThinking', previousPhase: 'preparing' })).toBe('preparing');
    expect(resolveChatPhase({ signal: 'thinking', previousPhase: 'deviceLoading' })).toBe('deviceLoading');
  });
});

describe('makePhaseSink', () => {
  function sinkWithLog() {
    const seen: (ChatPhaseId | null)[] = [];
    return { seen, sink: makePhaseSink((p) => seen.push(p)) };
  }

  it('applies each forward step exactly once and swallows repeats', () => {
    const { seen, sink } = sinkWithLog();
    sink('preparing');
    sink('preparing');
    sink('securing');
    sink('securing');
    expect(seen).toEqual(['preparing', 'securing']);
  });

  it('swallows a backwards signal without touching the line', () => {
    const { seen, sink } = sinkWithLog();
    sink('thinking');
    sink('securing');
    expect(seen).toEqual(['thinking']);
  });

  it('lets the `reasoning` re-emit of `thinking` be free after the post-headers route', () => {
    // Both routes publish `thinking`. The second must not re-render the line,
    // or a retry's second `reasoning` event restarts the dwell mid-sentence.
    const { seen, sink } = sinkWithLog();
    sink('thinking');
    sink('thinking');
    expect(seen).toEqual(['thinking']);
  });

  describe("'reset'", () => {
    it('clears the mark so the next leg re-walks its phases', () => {
      const { seen, sink } = sinkWithLog();
      sink('thinking');
      sink('reset');
      sink('securing');
      expect(seen).toEqual(['thinking', 'securing']);
    });

    it('does NOT clear the line, so there is no blank frame between legs', () => {
      const { seen, sink } = sinkWithLog();
      sink('thinking');
      sink('reset');
      expect(seen).toEqual(['thinking']);
    });
  });

  describe('release', () => {
    it('releases the line', () => {
      const { seen, sink } = sinkWithLog();
      sink('thinking');
      sink(null);
      expect(seen).toEqual(['thinking', null]);
    });

    // THE REGRESSION THIS PAIR EXISTS FOR. With one variable for both the
    // per-call mark and the displayed phase, `'reset'` makes the mark null, the
    // release then finds nothing to clear and returns early, and the line keeps
    // cycling underneath the error banner for the rest of the session.
    it('releases even when a `reset` has already cleared the mark', () => {
      const { seen, sink } = sinkWithLog();
      sink('thinking');
      sink('reset');
      sink(null);
      expect(seen).toEqual(['thinking', null]);
    });

    it('is idempotent, so a finally block after an error path costs nothing', () => {
      const { seen, sink } = sinkWithLog();
      sink('thinking');
      sink(null);
      sink(null);
      expect(seen).toEqual(['thinking', null]);
    });

    it('does nothing when the turn never published', () => {
      const { seen, sink } = sinkWithLog();
      sink(null);
      expect(seen).toEqual([]);
    });

    it('starts a fresh walk after a release', () => {
      const { seen, sink } = sinkWithLog();
      sink('thinking');
      sink(null);
      sink('preparing');
      expect(seen).toEqual(['thinking', null, 'preparing']);
    });
  });

  it('walks a realistic cold cloud turn, then a warm one, then the device', () => {
    const { seen, sink } = sinkWithLog();
    // cold: queued behind prewarm, attestation cache miss
    sink('preparing');
    sink('reset');
    sink('queued');
    sink('attesting');
    sink('thinking');
    sink(null);
    // warm: cache hit, no queue
    sink('preparing');
    sink('reset');
    sink('securing');
    sink('thinking');
    sink(null);
    // on-device
    sink('devicePreparing');
    sink('deviceThinking');
    sink(null);
    expect(seen).toEqual([
      'preparing', 'queued', 'attesting', 'thinking', null,
      'preparing', 'securing', 'thinking', null,
      'devicePreparing', 'deviceThinking', null,
    ]);
  });
});
