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
    getTranslationEpoch,
    isTranslationQueueActive,
    setAppStateSource,
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
