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
    probeTranslationLanguage,
    setLateTranslationSink,
    translateTextDetailed,
    __resetTranslationStateForTests,
} from '@/lib/translation-service';

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
