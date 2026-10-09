// Settings > Language and first launch wait for Apple's download sheet the same way: the notice
// never gives up while the sheet is (or was) up, and the language is applied when the download
// completes, however long it takes. Real translation-service, queue, app-language store, i18n and
// DB; the native translator (expo-translate-text), AppState and the clock are the only fakes.
import { act, renderHook } from '@testing-library/react-native';

// Loaded here, not lazily by the setup's beforeEach: test/helpers/screen.ts registers RNTL hooks on first import.
import { advanceUntilSettled, setAppState, useFakeClock } from '@/test/helpers';
import { NO_SHEET_MS, useLanguageDownloadNotice } from '@/components/custom/auth/use-language-download-notice';
import { getSetting } from '@/lib/database/services/setting-service';
import { useLanguageSwitch } from '@/lib/hooks/use-language-switch';
import i18n from '@/lib/i18n';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { __resetTranslationStateForTests } from '@/lib/translation-service';

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
function settingsPath(onCommitted: jest.Mock, onNoSheet: jest.Mock) {
    return renderHook(() => {
        const sw = useLanguageSwitch({ preview: false, onCommitted });
        const notice = useLanguageDownloadNotice(sw.cancel, onNoSheet);
        return { sw, notice };
    });
}

test('no give-up while the sheet is up, and the language applies when the download completes', async () => {
    const onCommitted = jest.fn();
    const onNoSheet = jest.fn();
    const { result } = settingsPath(onCommitted, onNoSheet);

    act(() => result.current.sw.requestSwitch('ar'));
    // preview: false, so the UI strings stay where they were while the probe runs.
    expect(i18n.language).toBe('en');
    await act(flushQueue);
    expect(nativeAnswers).toHaveLength(1);

    // Apple's sheet: iOS reports the app inactive for a moment, then active
    // again while the sheet stays up (a blip a late listener used to miss).
    act(() => {
        setAppState('inactive');
        setAppState('active');
    });
    act(() => jest.advanceTimersByTime(NO_SHEET_MS * 4));
    expect(onNoSheet).not.toHaveBeenCalled();
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

test('with no sign of a sheet the switch is let go after the window, and a late answer applies nothing', async () => {
    const onCommitted = jest.fn();
    const onNoSheet = jest.fn();
    const { result } = settingsPath(onCommitted, onNoSheet);

    act(() => result.current.sw.requestSwitch('ar'));
    await act(flushQueue);
    act(() => jest.advanceTimersByTime(NO_SHEET_MS));
    expect(onNoSheet).toHaveBeenCalledWith('ar');
    expect(result.current.sw.busy).toBe(false);

    await act(async () => {
        nativeAnswers[0]({ translatedTexts: 'مرحبا' });
        await flushQueue();
    });
    expect(useAppLanguageStore.getState().appLanguage).toBe('en');
    expect(await getSetting('app_language')).toBeNull();
    expect(onCommitted).not.toHaveBeenCalled();
    await advanceUntilSettled();
});
