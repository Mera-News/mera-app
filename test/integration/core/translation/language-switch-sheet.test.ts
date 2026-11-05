// Settings > Language and first launch wait for Apple's download sheet the same way: the notice
// never gives up while the sheet is (or was) up, and the language is applied when the download
// completes, however long it takes. Real translation-service, queue, app-language store, i18n and
// DB; the native translator (expo-translate-text), AppState and the clock are the only fakes.
import { act, renderHook } from '@testing-library/react-native';

// Loaded here, not lazily by the setup's beforeEach: test/helpers/screen.ts registers RNTL hooks on first import.
import { advanceUntilSettled, setAppState, useFakeClock } from '@/test/helpers';
import { useLanguageDownloadNotice } from '@/components/custom/auth/use-language-download-notice';
import { getSetting } from '@/lib/database/services/setting-service';
import { useLanguageSwitch } from '@/lib/hooks/use-language-switch';
import i18n from '@/lib/i18n';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { __resetTranslationStateForTests, isTranslationBlocked } from '@/lib/translation-service';

const mockOnTranslateTask: jest.Mock = jest.requireMock('expo-translate-text').onTranslateTask;

// Every native call hangs until the test answers it, standing in for Apple's sheet being up.
const nativeAnswers: ((v: { translatedTexts: string }) => void)[] = [];

const flushQueue = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(async () => {
    useFakeClock('2026-10-09T10:00:00Z');
    __resetTranslationStateForTests();
    nativeAnswers.length = 0;
    mockOnTranslateTask.mockReset();
    mockOnTranslateTask.mockImplementation(
        () => new Promise((resolve) => nativeAnswers.push(resolve)),
    );
    setAppState('active');
    useAppLanguageStore.setState({ appLanguage: 'en' });
    await i18n.changeLanguage('en');
});

/** The Settings screen's wiring: the switch, then the notice over it. */
function settingsPath(onCommitted: jest.Mock, onResult: jest.Mock = jest.fn()) {
    return renderHook(() => {
        const sw = useLanguageSwitch({ preview: false, onCommitted, onResult });
        const notice = useLanguageDownloadNotice();
        return { sw, notice };
    });
}

test('no give-up while the sheet is up, and the language applies when the download completes', async () => {
    const onCommitted = jest.fn();
    const { result } = await settingsPath(onCommitted);

    await act(() => result.current.sw.requestSwitch('ar'));
    // preview: false, so the UI strings stay where they were while the probe runs.
    expect(i18n.language).toBe('en');
    await act(flushQueue);
    expect(nativeAnswers).toHaveLength(1);

    // Apple's sheet: iOS reports the app inactive for a moment, then active
    // again while the sheet stays up (a blip a late listener used to miss).
    await act(() => {
        setAppState('inactive');
        setAppState('active');
    });
    await act(() => jest.advanceTimersByTime(30_000));
    expect(result.current.notice.noticeCode).toBe('ar');
    expect(result.current.sw.busy).toBe(true);

    // The download completes long after the no-sheet window.
    await act(async () => {
        nativeAnswers[0]({ translatedTexts: 'مرحبا' });
        await flushQueue();
    });
    expect(useAppLanguageStore.getState().appLanguage).toBe('ar');
    expect(i18n.language).toBe('ar');
    expect(await getSetting('app_language')).toBe('ar');
    expect(onCommitted).toHaveBeenCalledWith('ar', 'en');
    expect(result.current.sw.busy).toBe(false);
    expect(result.current.notice.noticeCode).toBeNull();
});

// Apple's sheet is drawn inside the app, so iOS reports nothing while it is up
// (measured on an iPhone: no AppState change in 37s). The switch waits on the
// call itself, however long the download takes.
test('with no sign of a sheet the switch still waits, and applies when the download completes', async () => {
    const onCommitted = jest.fn();
    const { result } = await settingsPath(onCommitted);

    await act(() => result.current.sw.requestSwitch('ar'));
    await act(flushQueue);
    await act(() => jest.advanceTimersByTime(30_000));
    expect(result.current.sw.busy).toBe(true);
    expect(result.current.notice.noticeCode).toBe('ar');

    await act(async () => {
        nativeAnswers[0]({ translatedTexts: 'مرحبا' });
        await flushQueue();
    });
    expect(useAppLanguageStore.getState().appLanguage).toBe('ar');
    expect(onCommitted).toHaveBeenCalledWith('ar', 'en');
});

test('closing the sheet is a cancel: the language stays, nothing is blocked, and a retry asks again', async () => {
    const onCommitted = jest.fn();
    const onResult = jest.fn();
    const { result } = await settingsPath(onCommitted, onResult);
    mockOnTranslateTask.mockImplementationOnce(() => Promise.reject(new Error('The operation was cancelled.')));

    await act(() => result.current.sw.requestSwitch('ar'));
    await act(flushQueue);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ code: 'ar', outcome: 'cancelled' }));
    expect(useAppLanguageStore.getState().appLanguage).toBe('en');
    expect(result.current.sw.busy).toBe(false);
    expect(isTranslationBlocked('ar')).toBe(false);
    // One native call: a decline is never retried behind the reader's back.
    expect(mockOnTranslateTask).toHaveBeenCalledTimes(1);

    await act(() => result.current.sw.requestSwitch('ar'));
    await act(flushQueue);
    expect(mockOnTranslateTask).toHaveBeenCalledTimes(2);
    await act(async () => {
        nativeAnswers[0]({ translatedTexts: 'مرحبا' });
        await flushQueue();
    });
    expect(useAppLanguageStore.getState().appLanguage).toBe('ar');
    await advanceUntilSettled();
});

describe('Android (ML Kit downloads with no sheet)', () => {
    const { Platform } = jest.requireActual<typeof import('react-native')>('react-native');
    let os: typeof Platform.OS;
    beforeEach(() => {
        os = Platform.OS;
        Platform.OS = 'android';
    });
    afterEach(() => {
        Platform.OS = os;
    });

    test('the notice shows while the pack downloads, with no give-up, and the language applies when it lands', async () => {
        const onCommitted = jest.fn();
        const { result } = await settingsPath(onCommitted);

        await act(() => result.current.sw.requestSwitch('nl'));
        await act(flushQueue);
        await act(() => jest.advanceTimersByTime(30_000));
        expect(result.current.notice.noticeCode).toBe('nl');
        expect(result.current.sw.busy).toBe(true);

        await act(async () => {
            nativeAnswers[0]({ translatedTexts: 'Hallo' });
            await flushQueue();
        });
        expect(useAppLanguageStore.getState().appLanguage).toBe('nl');
        expect(onCommitted).toHaveBeenCalledWith('nl', 'en');
        expect(result.current.notice.noticeCode).toBeNull();
    });
});
