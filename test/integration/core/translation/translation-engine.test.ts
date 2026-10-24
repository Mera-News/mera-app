// The translation engine's waste rules, driven through the real service and queue against the fake
// native module (expo-translate-text, mocked by the integration setup): a late answer is kept, a
// timeout is not retried, a backgrounded app asks nothing, and a screenful goes as one call.
const mockOnTranslateTask: jest.Mock = jest.requireMock('expo-translate-text').onTranslateTask;

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        captureMessage: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

import {
    isTranslationBlocked,
    NATIVE_SETTLE_CEILING_MS,
    probeTranslationLanguage,
    setLateTranslationSink,
    translateTextDetailed,
    __resetTranslationStateForTests,
} from '@/lib/translation-service';
import {
    __setTranslationBatchMaxForTests,
    bumpTranslationEpoch,
    getTranslationEpoch,
    isTranslationQueueActive,
    setAppStateSource,
    TRANSLATION_BATCH_MAX,
    TRANSLATION_BATCH_MAX_CHARS,
    useTranslationQueueActive,
} from '@/lib/translation-queue';
import { act, renderHook } from '@testing-library/react-native';

/** Open the iOS gate for a language the way production does: one successful probe. */
async function openGate(code: string): Promise<void> {
    mockOnTranslateTask.mockResolvedValueOnce({ translatedTexts: 'ok' });
    const p = probeTranslationLanguage(code);
    await jest.runAllTimersAsync();
    await p;
    mockOnTranslateTask.mockReset();
}

/** A native call that settles only when told to. */
function deferredNative() {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    jest.useFakeTimers();
    mockOnTranslateTask.mockReset();
    __resetTranslationStateForTests();
    setLateTranslationSink(null);
});

afterEach(() => {
    setLateTranslationSink(null);
    jest.useRealTimers();
});

describe('a native answer that lands after the JS timeout', () => {
    it('reaches the late sink with its text and language', async () => {
        await openGate('fr');
        const sink = jest.fn();
        setLateTranslationSink(sink);
        const native = deferredNative();
        mockOnTranslateTask.mockImplementationOnce(() => native.promise);

        // Any retry also hangs, so only the first call can answer late.
        mockOnTranslateTask.mockImplementation(() => new Promise(() => {}));
        const p = translateTextDetailed('Hello world', 'fr');
        await jest.runAllTimersAsync();
        expect(await p).toEqual({ status: 'failed', text: null });
        expect(sink).not.toHaveBeenCalled();

        native.resolve({ translatedTexts: 'Bonjour le monde' });
        await jest.advanceTimersByTimeAsync(0);
        expect(sink).toHaveBeenCalledWith('Hello world', 'fr', 'Bonjour le monde');
    });

    it('is cached by the app language store while the reader is still in that language', async () => {
        const { useAppLanguageStore } = require('@/lib/stores/app-language-store') as typeof import('@/lib/stores/app-language-store');
        await openGate('fr');
        useAppLanguageStore.setState({ appLanguage: 'fr', cache: new Map() });
        const native = deferredNative();
        mockOnTranslateTask.mockImplementation(() => new Promise(() => {}));
        mockOnTranslateTask.mockImplementationOnce(() => native.promise);

        const p = translateTextDetailed('Late title', 'fr');
        await jest.runAllTimersAsync();
        await p;
        native.resolve({ translatedTexts: 'Titre tardif' });
        await jest.advanceTimersByTimeAsync(0);
        expect(useAppLanguageStore.getState().cache.get('Late title')).toBe('Titre tardif');

        // A switch away means the late text is for a language nobody reads now.
        useAppLanguageStore.setState({ appLanguage: 'de', cache: new Map() });
        const second = deferredNative();
        mockOnTranslateTask.mockImplementationOnce(() => second.promise);
        const q = translateTextDetailed('Other title', 'fr');
        await jest.runAllTimersAsync();
        await q;
        second.resolve({ translatedTexts: 'Autre titre' });
        await jest.advanceTimersByTimeAsync(0);
        expect(useAppLanguageStore.getState().cache.get('Other title')).toBeUndefined();
    });
});

describe("'skipped' versus 'failed'", () => {
    it("is 'skipped' when the gate refuses an unverified iOS language, with no native call", async () => {
        const p = translateTextDetailed('Hello', 'de');
        await jest.runAllTimersAsync();
        expect(await p).toEqual({ status: 'skipped', text: null });
        expect(mockOnTranslateTask).not.toHaveBeenCalled();
    });

    it("is 'skipped' while the breaker is open, and 'failed' only after a real native attempt", async () => {
        await openGate('fr');
        mockOnTranslateTask.mockRejectedValue(new Error('nope'));
        const first = translateTextDetailed('A', 'fr');
        await jest.runAllTimersAsync();
        expect(await first).toEqual({ status: 'failed', text: null });

        // A failed probe opens the breaker for the language.
        const probe = probeTranslationLanguage('fr');
        await jest.runAllTimersAsync();
        expect(await probe).toBe('failed');
        expect(isTranslationBlocked('fr')).toBe(true);
        mockOnTranslateTask.mockReset();
        const second = translateTextDetailed('B', 'fr');
        await jest.runAllTimersAsync();
        expect(await second).toEqual({ status: 'skipped', text: null });
        expect(mockOnTranslateTask).not.toHaveBeenCalled();
    });
});

describe('a native call that outlives its 20s timeout', () => {
    it('is not retried, and never counts toward the breaker', async () => {
        await openGate('fr');
        mockOnTranslateTask.mockImplementation(() => new Promise(() => {}));
        // More timeouts than the verified threshold (5).
        for (let i = 0; i < 7; i++) {
            const p = translateTextDetailed(`Slow ${i}`, 'fr');
            await jest.runAllTimersAsync();
            expect(await p).toEqual({ status: 'failed', text: null });
        }
        expect(mockOnTranslateTask).toHaveBeenCalledTimes(7);
        expect(isTranslationBlocked('fr')).toBe(false);
    });

    it('answers its caller at the timeout but holds the slot until the native call settles', async () => {
        await openGate('fr');
        const slow = deferredNative();
        mockOnTranslateTask.mockImplementationOnce(() => slow.promise);
        mockOnTranslateTask.mockImplementation(async () => ({ translatedTexts: 'Suivant' }));

        const first = translateTextDetailed('Slow', 'fr');
        const second = translateTextDetailed('Next', 'fr');
        await jest.advanceTimersByTimeAsync(20_100);
        expect(await first).toEqual({ status: 'failed', text: null });
        expect(mockOnTranslateTask).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(10_000);
        expect(mockOnTranslateTask).toHaveBeenCalledTimes(1);
        slow.resolve({ translatedTexts: 'Lent' });
        await jest.advanceTimersByTimeAsync(0);
        expect(await second).toEqual({ status: 'ok', text: 'Suivant' });
    });

    it('frees the slot at the ceiling when the native call never settles', async () => {
        await openGate('fr');
        mockOnTranslateTask.mockImplementationOnce(() => new Promise(() => {}));
        mockOnTranslateTask.mockImplementation(async () => ({ translatedTexts: 'Suivant' }));

        void translateTextDetailed('Wedged', 'fr');
        const second = translateTextDetailed('Next', 'fr');
        await jest.advanceTimersByTimeAsync(NATIVE_SETTLE_CEILING_MS - 100);
        expect(mockOnTranslateTask).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(200);
        expect(await second).toEqual({ status: 'ok', text: 'Suivant' });
    });
});

describe('the per-text retry budget', () => {
    it("gives a text one retry after 'failed', then answers 'failed' with no native call", async () => {
        await openGate('fr');
        mockOnTranslateTask.mockRejectedValue(new Error('nope'));

        for (let i = 0; i < 2; i++) {
            const p = translateTextDetailed('Bad', 'fr');
            await jest.runAllTimersAsync();
            expect(await p).toEqual({ status: 'failed', text: null });
        }
        const callsAfterTwo = mockOnTranslateTask.mock.calls.length;
        const third = translateTextDetailed('Bad', 'fr');
        await jest.runAllTimersAsync();
        expect(await third).toEqual({ status: 'failed', text: null });
        expect(mockOnTranslateTask).toHaveBeenCalledTimes(callsAfterTwo);

        // The budget is per text: another string still asks the OS.
        mockOnTranslateTask.mockResolvedValue({ translatedTexts: 'Bon' });
        const other = translateTextDetailed('Good', 'fr');
        await jest.runAllTimersAsync();
        expect(await other).toEqual({ status: 'ok', text: 'Bon' });
    });
});

describe('the app leaving the foreground', () => {
    type Mode = 'active' | 'inactive' | 'background';
    let emit: (mode: Mode) => void = () => {};
    const fakeAppState = {
        currentState: 'active',
        addEventListener: (_type: 'change', fn: (mode: string) => void) => {
            emit = fn;
            return { remove: () => { emit = () => {}; } };
        },
    };

    beforeEach(() => {
        setAppStateSource(fakeAppState);
    });

    afterEach(() => {
        emit('active');
    });

    it('background drops the queue, leaves the call in flight, and dispatches nothing until active', async () => {
        await openGate('fr');
        const head = deferredNative();
        mockOnTranslateTask.mockImplementationOnce(() => head.promise);
        mockOnTranslateTask.mockImplementation(async () => ({ translatedTexts: 'Plus tard' }));

        const inFlight = translateTextDetailed('Head', 'fr');
        await jest.advanceTimersByTimeAsync(0);
        const queued = translateTextDetailed('Queued', 'fr');
        const epochBefore = getTranslationEpoch();

        emit('background');
        expect(await queued).toEqual({ status: 'dropped', text: null });
        head.resolve({ translatedTexts: 'Tête' });
        expect(await inFlight).toEqual({ status: 'ok', text: 'Tête' });

        const asked = translateTextDetailed('Asked while away', 'fr');
        await jest.advanceTimersByTimeAsync(1_000);
        expect(mockOnTranslateTask).toHaveBeenCalledTimes(1);

        emit('active');
        expect(getTranslationEpoch()).toBe(epochBefore + 1);
        // Stamped before the bump, so it is dropped too: its node re-asks once active.
        expect(await asked).toEqual({ status: 'dropped', text: null });
        const again = translateTextDetailed('Asked while away', 'fr');
        await jest.runAllTimersAsync();
        expect(await again).toEqual({ status: 'ok', text: 'Plus tard' });
    });

    it('inactive holds dispatch but keeps the queue, and bumps nothing', async () => {
        await openGate('fr');
        mockOnTranslateTask.mockImplementation(async () => ({ translatedTexts: 'Gardé' }));
        emit('inactive');
        const held = translateTextDetailed('Held', 'fr');
        await jest.advanceTimersByTimeAsync(1_000);
        expect(mockOnTranslateTask).not.toHaveBeenCalled();
        expect(isTranslationQueueActive()).toBe(false);

        const epochBefore = getTranslationEpoch();
        emit('active');
        await jest.runAllTimersAsync();
        expect(await held).toEqual({ status: 'ok', text: 'Gardé' });
        expect(getTranslationEpoch()).toBe(epochBefore);
    });

    it('never drops the probe, but holds it until active', async () => {
        mockOnTranslateTask.mockImplementation(async () => ({ translatedTexts: 'Hallo' }));
        emit('background');
        const probe = probeTranslationLanguage('de');
        await jest.advanceTimersByTimeAsync(1_000);
        expect(mockOnTranslateTask).not.toHaveBeenCalled();
        emit('active');
        await jest.runAllTimersAsync();
        expect(await probe).toBe('success');
    });

    it("a failure that settles while away is 'dropped' and costs the text and language nothing", async () => {
        await openGate('fr');
        const call = deferredNative();
        mockOnTranslateTask.mockImplementationOnce(() => call.promise);
        const p = translateTextDetailed('Interrupted', 'fr');
        await jest.advanceTimersByTimeAsync(0);
        emit('background');
        call.reject(new Error('The operation was cancelled.'));
        await jest.advanceTimersByTimeAsync(0);
        expect(await p).toEqual({ status: 'dropped', text: null });

        // A call that spanned a background is dropped even if it fails after the return.
        emit('active');
        const spanning = deferredNative();
        mockOnTranslateTask.mockImplementationOnce(() => spanning.promise);
        const q = translateTextDetailed('Spanning', 'fr');
        await jest.advanceTimersByTimeAsync(0);
        emit('background');
        emit('active');
        spanning.reject(new Error('The operation was cancelled.'));
        await jest.advanceTimersByTimeAsync(0);
        expect(await q).toEqual({ status: 'dropped', text: null });

        // Neither counted: the budget still allows two real failures for each text.
        mockOnTranslateTask.mockResolvedValue({ translatedTexts: 'Enfin' });
        const r = translateTextDetailed('Interrupted', 'fr');
        await jest.runAllTimersAsync();
        expect(await r).toEqual({ status: 'ok', text: 'Enfin' });
        expect(isTranslationBlocked('fr')).toBe(false);
    });

    it('useTranslationQueueActive follows the app state', () => {
        const { result } = renderHook(() => useTranslationQueueActive());
        expect(result.current).toBe(true);
        act(() => emit('inactive'));
        expect(result.current).toBe(false);
        act(() => emit('active'));
        expect(result.current).toBe(true);
    });
});

describe('batching a screenful into one native call', () => {
    /**
     * A fake native module shaped like the real bridges: a string answers a string; a keyed object
     * answers by key, but with its keys written in REVERSE completion order; an array answers in a
     * shuffled order (the Android bridge appends in completion order).
     */
    const fr = (t: string) => `fr:${t}`;
    function nativeLikeTheBridges(args: { input: unknown }): Promise<{ translatedTexts: unknown }> {
        const { input } = args;
        if (typeof input === 'string') return Promise.resolve({ translatedTexts: fr(input) });
        if (Array.isArray(input)) return Promise.resolve({ translatedTexts: [...input].reverse().map(fr) });
        const out: Record<string, string> = {};
        for (const key of Object.keys(input as object).reverse()) out[key] = fr((input as Record<string, string>)[key]);
        return Promise.resolve({ translatedTexts: out });
    }

    /** Hold the one slot so everything asked next is still queued when it frees. */
    async function holdSlot(): Promise<() => void> {
        const head = deferredNative();
        mockOnTranslateTask.mockImplementationOnce(() => head.promise);
        void translateTextDetailed('Head', 'fr');
        await jest.advanceTimersByTimeAsync(0);
        return () => head.resolve({ translatedTexts: 'tête' });
    }

    const batchCalls = () => mockOnTranslateTask.mock.calls.filter(([a]) => typeof a.input !== 'string');
    const singleCalls = () => mockOnTranslateTask.mock.calls.filter(([a]) => typeof a.input === 'string');

    beforeEach(async () => {
        await openGate('fr');
        mockOnTranslateTask.mockImplementation(nativeLikeTheBridges);
    });

    afterEach(() => {
        __setTranslationBatchMaxForTests(TRANSLATION_BATCH_MAX);
    });

    it('sends 8 queued texts as ONE keyed call, in priority order, and gives each its own answer', async () => {
        const release = await holdSlot();
        const texts = Array.from({ length: 8 }, (_, i) => `Title ${i}`);
        // Asked bottom first: priority, not arrival, orders the batch.
        const results = texts.map((t, i) => translateTextDetailed(t, 'fr', { priority: 800 - i * 100 }));
        release();
        await jest.runAllTimersAsync();

        expect(batchCalls()).toHaveLength(1);
        const input = batchCalls()[0][0].input as Record<string, string>;
        expect(Array.isArray(input)).toBe(false);
        expect(Object.keys(input)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
        expect(input['0']).toBe('Title 7');
        for (let i = 0; i < 8; i++) {
            expect(await results[i]).toEqual({ status: 'ok', text: fr(texts[i]) });
        }
    });

    it('a failed batch sends each text alone, and only the bad text fails', async () => {
        mockOnTranslateTask.mockImplementation((args: { input: unknown }) => {
            if (typeof args.input !== 'string') return Promise.reject(new Error('Unable to Translate'));
            if (args.input === 'Bad') return Promise.reject(new Error('Unable to Translate'));
            return nativeLikeTheBridges(args);
        });
        const release = await holdSlot();
        const texts = ['A', 'B', 'Bad', 'C'];
        const results = texts.map((t) => translateTextDetailed(t, 'fr'));
        release();
        await jest.runAllTimersAsync();

        expect(await results[0]).toEqual({ status: 'ok', text: 'fr:A' });
        expect(await results[2]).toEqual({ status: 'failed', text: null });
        expect(await results[3]).toEqual({ status: 'ok', text: 'fr:C' });
        expect(batchCalls()).toHaveLength(1);
        expect(isTranslationBlocked('fr')).toBe(false);

        // A text that failed in a batch is never batched again.
        mockOnTranslateTask.mockClear();
        const release2 = await holdSlot();
        const again = [translateTextDetailed('Bad', 'fr'), translateTextDetailed('D', 'fr'), translateTextDetailed('E', 'fr')];
        release2();
        await jest.runAllTimersAsync();
        await Promise.all(again);
        expect(singleCalls().map(([a]) => a.input)).toContain('Bad');
        expect(batchCalls().map(([a]) => Object.values(a.input))).toEqual([['D', 'E']]);
    });

    it('a missing key sends just that text again alone', async () => {
        mockOnTranslateTask.mockImplementation((args: { input: unknown }) => {
            if (typeof args.input === 'string') return nativeLikeTheBridges(args);
            return Promise.resolve({ translatedTexts: { 0: 'fr:A' } });
        });
        const release = await holdSlot();
        const results = [translateTextDetailed('A', 'fr'), translateTextDetailed('B', 'fr')];
        release();
        await jest.runAllTimersAsync();
        expect(await results[0]).toEqual({ status: 'ok', text: 'fr:A' });
        expect(await results[1]).toEqual({ status: 'ok', text: 'fr:B' });
        expect(singleCalls().map(([a]) => a.input)).toEqual(['Head', 'B']);
    });

    it('a batch that times out fails without a retry, keeps the breaker closed, and every late answer lands', async () => {
        const sink = jest.fn();
        setLateTranslationSink(sink);
        const slow = deferredNative();
        mockOnTranslateTask.mockImplementation((args: { input: unknown }) =>
            typeof args.input === 'string' ? nativeLikeTheBridges(args) : slow.promise);
        const release = await holdSlot();
        const texts = Array.from({ length: 8 }, (_, i) => `Slow ${i}`);
        const results = texts.map((t) => translateTextDetailed(t, 'fr'));
        release();
        await jest.advanceTimersByTimeAsync(20_100);
        for (const r of results) expect(await r).toEqual({ status: 'failed', text: null });
        expect(batchCalls()).toHaveLength(1);
        expect(isTranslationBlocked('fr')).toBe(false);

        const answers: Record<string, string> = {};
        for (let i = 7; i >= 0; i--) answers[String(i)] = `fr:Slow ${i}`;
        slow.resolve({ translatedTexts: answers });
        await jest.advanceTimersByTimeAsync(0);
        for (const t of texts) expect(sink).toHaveBeenCalledWith(t, 'fr', `fr:${t}`);
        expect(isTranslationBlocked('fr')).toBe(false);
    });

    it('caps a batch at TRANSLATION_BATCH_MAX_CHARS', async () => {
        const release = await holdSlot();
        const long = (c: string) => c.repeat(700);
        void translateTextDetailed(long('a'), 'fr');
        void translateTextDetailed(long('b'), 'fr');
        void translateTextDetailed(long('c'), 'fr');
        release();
        await jest.runAllTimersAsync();
        // 700 + 700 fits under 1500; the third would not, so it goes next, alone.
        expect(batchCalls()).toHaveLength(1);
        expect(Object.keys(batchCalls()[0][0].input)).toHaveLength(2);
        expect(singleCalls().map(([a]) => a.input)).toEqual(['Head', long('c')]);
        expect(TRANSLATION_BATCH_MAX_CHARS).toBe(1500);
    });

    it('the same text asked twice joins one call', async () => {
        const release = await holdSlot();
        const first = translateTextDetailed('Twice', 'fr');
        const second = translateTextDetailed('Twice', 'fr');
        void translateTextDetailed('Other', 'fr');
        release();
        await jest.runAllTimersAsync();
        expect(await first).toEqual({ status: 'ok', text: 'fr:Twice' });
        expect(await second).toEqual({ status: 'ok', text: 'fr:Twice' });
        expect(Object.values(batchCalls()[0][0].input)).toEqual(['Twice', 'Other']);
    });

    it('never batches the probe', async () => {
        const release = await holdSlot();
        mockOnTranslateTask.mockImplementation(nativeLikeTheBridges);
        const probe = probeTranslationLanguage('fr');
        const a = translateTextDetailed('A', 'fr');
        const b = translateTextDetailed('B', 'fr');
        release();
        await jest.runAllTimersAsync();
        expect(await probe).toBe('success');
        await Promise.all([a, b]);
        expect(singleCalls().map(([x]) => x.input)).toEqual(['Head', 'Hello']);
        expect(batchCalls().map(([x]) => Object.values(x.input))).toEqual([['A', 'B']]);
    });

    it('TRANSLATION_BATCH_MAX = 1 turns batching fully off', async () => {
        __setTranslationBatchMaxForTests(1);
        const release = await holdSlot();
        const results = ['A', 'B', 'C'].map((t) => translateTextDetailed(t, 'fr'));
        release();
        await jest.runAllTimersAsync();
        expect(batchCalls()).toHaveLength(0);
        expect(singleCalls().map(([a]) => a.input)).toEqual(['Head', 'A', 'B', 'C']);
        expect(await results[1]).toEqual({ status: 'ok', text: 'fr:B' });
    });
});

// The invariant the reverted visible-first rewrite broke on device: whatever the reader does, every
// node on screen ends translated. Nodes follow the render-surface contract: show the cache if it has
// the text, else ask; re-ask a 'dropped' text (or a first 'failed' one) only while the app is active,
// the node's screen is on top and its page is the visible one.
describe('every visible node ends translated', () => {
    it('after swipes, a background, a route push and pop', async () => {
        await openGate('fr');
        let emit: (mode: string) => void = () => {};
        setAppStateSource({
            currentState: 'active',
            addEventListener: (_t, fn) => {
                emit = fn;
                return { remove: () => { emit = () => {}; } };
            },
        });
        const cache = new Map<string, string>();
        setLateTranslationSink((text, _lang, translated) => cache.set(text, translated));

        // A native module that answers keyed batches out of order and is slow on every 7th call.
        let calls = 0;
        mockOnTranslateTask.mockImplementation(({ input }: { input: unknown }) => {
            calls += 1;
            const answer = typeof input === 'string'
                ? `fr:${input}`
                : Object.fromEntries(Object.entries(input as Record<string, string>).reverse().map(([k, v]) => [k, `fr:${v}`]));
            // Every third batch fails outright, so its texts must go again alone.
            if (typeof input !== 'string' && calls % 3 === 0) return Promise.reject(new Error('Unable to Translate'));
            const delay = calls % 7 === 0 ? 25_000 : 300;
            return new Promise((r) => setTimeout(() => r({ translatedTexts: answer }), delay));
        });

        type Screen = 'tabs' | 'detail';
        const ui = { top: 'tabs' as Screen, page: 'feed' };
        const nodes = [
            ...Array.from({ length: 12 }, (_, i) => ({ text: `Feed ${i}`, screen: 'tabs' as Screen, page: 'feed' })),
            ...Array.from({ length: 6 }, (_, i) => ({ text: `Story ${i}`, screen: 'tabs' as Screen, page: 'stories' })),
            ...Array.from({ length: 4 }, (_, i) => ({ text: `Detail ${i}`, screen: 'detail' as Screen, page: 'detail' })),
        ].map((n, i) => ({ ...n, y: i * 50, asking: false, failedOnce: false }));
        const visible = (n: (typeof nodes)[number]) =>
            n.screen === ui.top && (n.screen === 'detail' || n.page === ui.page);
        const canAsk = (n: (typeof nodes)[number]) => isTranslationQueueActive() && visible(n);

        function ask(n: (typeof nodes)[number]): void {
            if (cache.has(n.text) || n.asking || !canAsk(n)) return;
            n.asking = true;
            void translateTextDetailed(n.text, 'fr', { priority: n.y }).then((r) => {
                n.asking = false;
                if (r.status === 'ok') cache.set(n.text, r.text!);
                else if (r.status === 'dropped') ask(n);
                else if (r.status === 'failed' && !n.failedOnce) {
                    n.failedOnce = true;
                    ask(n);
                }
            });
        }
        const askAll = () => nodes.forEach(ask);

        askAll();
        await jest.advanceTimersByTimeAsync(400);
        // Swipe to Stories (TabPages' pick), then the app goes away mid-flight and comes back.
        ui.page = 'stories';
        bumpTranslationEpoch('page:stories');
        askAll();
        await jest.advanceTimersByTimeAsync(100);
        emit('background');
        await jest.advanceTimersByTimeAsync(2_000);
        emit('active');
        askAll();
        await jest.advanceTimersByTimeAsync(200);
        // Push a story, then pop back.
        ui.top = 'detail';
        bumpTranslationEpoch('/logged-in/news-detail/1');
        askAll();
        await jest.advanceTimersByTimeAsync(500);
        ui.top = 'tabs';
        bumpTranslationEpoch('/logged-in/app_container/feed');
        askAll();
        // Swipe back to the Feed.
        await jest.advanceTimersByTimeAsync(100);
        ui.page = 'feed';
        bumpTranslationEpoch('page:feed');
        askAll();
        await jest.runAllTimersAsync();
        // A node that timed out reads its late answer from the cache on its next render.
        askAll();
        await jest.runAllTimersAsync();

        const shown = nodes.filter(visible);
        expect(shown).toHaveLength(12);
        for (const n of shown) expect(cache.get(n.text)).toBe(`fr:${n.text}`);
        expect(isTranslationBlocked('fr')).toBe(false);
    });
});
