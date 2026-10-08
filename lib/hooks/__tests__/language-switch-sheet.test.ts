// Settings > Language and first launch wait for Apple's download sheet the same
// way: the notice never gives up while the sheet is (or was) up, and the
// language is applied when the download completes, however long it takes.

const mockResolvers: Array<(v: 'success' | 'failed') => void> = [];
jest.mock('@/lib/translation-service', () => ({
    probeTranslationLanguage: jest.fn(
        () => new Promise<'success' | 'failed'>((resolve) => mockResolvers.push(resolve)),
    ),
    resolveUiLocale: (code: string) => code,
}));

const mockState = {
    appLanguage: 'en',
    setAppLanguage: jest.fn(async (code: string) => {
        mockState.appLanguage = code;
    }),
};
jest.mock('@/lib/stores/app-language-store', () => {
    const useAppLanguageStore = (selector: (s: typeof mockState) => unknown) => selector(mockState);
    useAppLanguageStore.getState = () => mockState;
    return { useAppLanguageStore };
});
jest.mock('@/lib/i18n', () => ({ previewLanguage: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn() } }));

import { act, renderHook } from '@testing-library/react-native';
import { AppState, Platform } from 'react-native';

import { NO_SHEET_MS, useLanguageDownloadNotice } from '@/components/custom/auth/use-language-download-notice';
import { previewLanguage } from '@/lib/i18n';
import { useLanguageSwitch } from '@/lib/hooks/use-language-switch';

type Handler = (state: string) => void;
let handlers: Handler[] = [];

beforeEach(() => {
    jest.useFakeTimers();
    Platform.OS = 'ios';
    mockState.appLanguage = 'en';
    mockState.setAppLanguage.mockClear();
    mockResolvers.length = 0;
    handlers = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, h: Handler) => {
        handlers.push(h);
        return { remove: () => (handlers = handlers.filter((x) => x !== h)) };
    }) as never);
    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});

afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
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
    expect(previewLanguage).not.toHaveBeenCalled();
    // Apple's sheet: iOS reports the app inactive for a moment, then active
    // again while the sheet stays up (a blip a late listener used to miss).
    act(() => {
        handlers.forEach((h) => h('inactive'));
        handlers.forEach((h) => h('active'));
    });
    act(() => jest.advanceTimersByTime(NO_SHEET_MS * 4));
    expect(onNoSheet).not.toHaveBeenCalled();
    expect(result.current.notice.noticeCode).toBe('ar');
    expect(result.current.sw.busy).toBe(true);

    // The download completes long after the no-sheet window.
    await act(async () => {
        mockResolvers[0]('success');
    });
    expect(mockState.setAppLanguage).toHaveBeenCalledWith('ar');
    expect(onCommitted).toHaveBeenCalledWith('ar', 'en');
    expect(result.current.sw.busy).toBe(false);
    expect(result.current.notice.noticeCode).toBeNull();
});

test('with no sign of a sheet the switch is let go after the window, and a late answer applies nothing', async () => {
    const onCommitted = jest.fn();
    const onNoSheet = jest.fn();
    const { result } = settingsPath(onCommitted, onNoSheet);

    act(() => result.current.sw.requestSwitch('ar'));
    act(() => jest.advanceTimersByTime(NO_SHEET_MS));
    expect(onNoSheet).toHaveBeenCalledWith('ar');
    expect(result.current.sw.busy).toBe(false);

    await act(async () => {
        mockResolvers[0]('success');
    });
    expect(mockState.setAppLanguage).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
});
