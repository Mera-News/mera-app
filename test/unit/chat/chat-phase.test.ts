import {
  CHAT_PHASE_IDS,
  CLOUD_PHASE_ORDER,
  DEVICE_PHASE_ORDER,
  chatPhaseIndex,
  isModelCallPhase,
  makePhaseSink,
  resolveChatPhase,
  stepKindForTool,
  stripStateFor,
  type ChatPhaseId,
  type ChatPhaseView,
  type StripState,
} from '@/lib/services/chat-phase';
import { applyChatPhase, useChatPhaseStore } from '@/lib/llm/chat-phase-store';

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

  it('a cold call advances from attesting to securing: the key arrives, then the message is sealed', () => {
    expect(resolveChatPhase({ signal: 'securing', previousPhase: 'attesting' })).toBe('securing');
    expect(resolveChatPhase({ signal: 'attesting', previousPhase: 'securing' })).toBe('securing');
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
    sink('securing');
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
      'preparing', 'queued', 'attesting', 'securing', 'thinking', null,
      'preparing', 'securing', 'thinking', null,
      'devicePreparing', 'deviceThinking', null,
    ]);
  });
});

// THE STRIP. Every view, both deviceWork values, both engines, against a table written out by hand,
// so a change to any row fails here rather than being re-derived by the code under test.
describe('stripStateFor', () => {
  const views: [string, ChatPhaseView][] = [
    ['idle', { kind: 'idle' }],
    ['released', { kind: 'released' }],
    ...CHAT_PHASE_IDS.map((id): [string, ChatPhaseView] => [id, { kind: 'phase', id }]),
  ];

  const CLOUD: Record<string, StripState | null> = {
    idle: 'phone', released: null,
    preparing: 'phone', queued: 'phone', attesting: 'attest', securing: 'secure',
    thinking: 'think', retrying: 'retry', webSearch: 'phone',
    // A device id on a cloud turn cannot happen; it must still not draw a sealed letter.
    deviceLoading: 'phone', devicePreparing: 'phone', deviceThinking: 'phone',
  };
  // Work on the phone beats every cloud phase except a retry, which is a real resend.
  const CLOUD_DEVICE_WORK: Record<string, StripState | null> = {
    idle: 'phone', released: 'phone',
    preparing: 'phone', queued: 'phone', attesting: 'phone', securing: 'phone',
    thinking: 'phone', retrying: 'retry', webSearch: 'phone',
    deviceLoading: 'phone', devicePreparing: 'phone', deviceThinking: 'phone',
  };
  // On device nothing is sealed or sent; deviceWork changes nothing.
  const LOCAL: Record<string, StripState | null> = {
    idle: 'devicePreparing', released: null,
    preparing: 'devicePreparing', queued: 'devicePreparing', attesting: 'devicePreparing',
    securing: 'devicePreparing', thinking: 'devicePreparing', retrying: 'devicePreparing',
    webSearch: 'devicePreparing',
    deviceLoading: 'deviceLoading', devicePreparing: 'devicePreparing', deviceThinking: 'deviceThinking',
  };

  it('the tables cover every view', () => {
    for (const table of [CLOUD, CLOUD_DEVICE_WORK, LOCAL]) {
      expect(Object.keys(table).sort()).toEqual(views.map(([name]) => name).sort());
    }
  });

  it.each(views)('%s', (name, view) => {
    expect(stripStateFor(view, false, 'cloud')).toBe(CLOUD[name]);
    expect(stripStateFor(view, true, 'cloud')).toBe(CLOUD_DEVICE_WORK[name]);
    expect(stripStateFor(view, false, 'local')).toBe(LOCAL[name]);
    expect(stripStateFor(view, true, 'local')).toBe(LOCAL[name]);
  });
});

describe('stepKindForTool', () => {
  it('maps each CONTRACT tool name to its step kind', () => {
    expect({
      find_similar_facts: stepKindForTool('find_similar_facts'),
      lookup_place: stepKindForTool('lookup_place'),
      saveExtractedFacts: stepKindForTool('saveExtractedFacts'),
      deleteUserFacts: stepKindForTool('deleteUserFacts'),
      ask_choice: stepKindForTool('ask_choice'),
      webSearch: stepKindForTool('webSearch'),
      load_skill: stepKindForTool('load_skill'),
      explainMera: stepKindForTool('explainMera'),
    }).toEqual({
      find_similar_facts: 'facts',
      lookup_place: 'place',
      saveExtractedFacts: 'write',
      deleteUserFacts: 'remove',
      ask_choice: 'ask',
      webSearch: 'web',
      load_skill: 'skill',
      explainMera: 'working',
    });
  });

  it('gives an unknown or port-style name the generic kind, never a guess', () => {
    for (const name of ['', 'lookupPlace', 'findSimilarFacts', 'searchNews', 'toString']) {
      expect(stepKindForTool(name)).toBe('working');
    }
  });
});

describe('isModelCallPhase', () => {
  it('is true only for the phases a model call publishes', () => {
    expect(CHAT_PHASE_IDS.filter(isModelCallPhase)).toEqual(['queued', 'attesting', 'securing', 'thinking', 'retrying']);
  });
});

// The store, driven through the sink both engines use.
describe('chat-phase-store', () => {
  const store = () => useChatPhaseStore.getState();
  const place = { kind: 'place' as const, toolName: 'lookup_place', args: { query: 'Porto' } };

  beforeEach(() => store().reset());

  it('sets retriedThisTurn on retrying, keeps it past the release, and clears it on the next turn', () => {
    const sink = makePhaseSink(applyChatPhase);
    sink('securing');
    expect(store().retriedThisTurn).toBe(false);
    sink('retrying');
    sink(null);
    expect(store().retriedThisTurn).toBe(true);
    store().reset();
    expect(store().retriedThisTurn).toBe(false);
  });

  it('advances sealedSeq once per sealing phase, so securing then thinking in one tick still owes the letter', () => {
    const before = store().sealedSeq;
    const sink = makePhaseSink(applyChatPhase);
    sink('securing');
    sink('thinking');
    expect(store().view).toEqual({ kind: 'phase', id: 'thinking' });
    expect(store().sealedSeq).toBe(before + 1);
  });

  it('a cold call seals twice (attesting, then securing) and a second leg seals again', () => {
    const before = store().sealedSeq;
    const sink = makePhaseSink(applyChatPhase);
    sink('attesting');
    sink('securing');
    sink('thinking');
    sink('reset');
    sink('securing');
    expect(store().sealedSeq).toBe(before + 3);
  });

  it('never rewinds sealedSeq on reset, so a viewer comparing to the last seq it played cannot miss one', () => {
    makePhaseSink(applyChatPhase)('securing');
    const seq = store().sealedSeq;
    store().reset();
    expect(store().sealedSeq).toBe(seq);
  });

  it('a live tool sets deviceWork, and its end clears both', () => {
    store().toolStarted(place);
    expect(store().liveTool).toEqual(place);
    expect(store().deviceWork).toBe(true);
    store().toolEnded();
    expect(store().liveTool).toBeNull();
    expect(store().deviceWork).toBe(false);
  });

  it('the webSearch phase keeps the live tool; the next model call clears it', () => {
    const sink = makePhaseSink(applyChatPhase);
    sink('thinking');
    const web = { kind: 'web' as const, toolName: 'webSearch', args: { queries: ['x'] } };
    store().toolStarted(web);
    sink('webSearch');
    expect(store().liveTool).toEqual(web);
    expect(store().deviceWork).toBe(true);
    sink('reset');
    sink('securing');
    expect(store().liveTool).toBeNull();
    expect(store().deviceWork).toBe(false);
  });

  it('release clears the live tool and deviceWork even when the line was already released', () => {
    const sink = makePhaseSink(applyChatPhase);
    sink('thinking');
    sink(null);
    store().toolStarted(place);
    store().setDeviceWork(true);
    store().release();
    expect(store().liveTool).toBeNull();
    expect(store().deviceWork).toBe(false);
  });

  it('reset clears every field even when the view is already idle', () => {
    store().toolStarted(place);
    expect(store().view.kind).toBe('idle');
    store().reset();
    expect(store().liveTool).toBeNull();
    expect(store().deviceWork).toBe(false);
  });

  it('setDeviceWork toggles the flag on its own', () => {
    store().setDeviceWork(true);
    expect(store().deviceWork).toBe(true);
    expect(store().liveTool).toBeNull();
    store().setDeviceWork(false);
    expect(store().deviceWork).toBe(false);
  });
});
