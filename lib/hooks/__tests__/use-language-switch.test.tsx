// The language-switch state machine.
//
// Everything here is behaviour the simulator cannot show, because on-device
// translation never succeeds there — so these specs are the only evidence for
// the cancel, timeout and navigation-lock paths.

const mockProbe = jest.fn();
const mockSetAppLanguage = jest.fn(() => Promise.resolve());
const mockPreviewLanguage = jest.fn();
let mockAppLanguage = 'en';

jest.mock('@/lib/translation-service', () => ({
    probeTranslationLanguage: (...a: unknown[]) => mockProbe(...a),
    // The real one: a code is a UI locale iff the app bundles strings for it.
    // Every code the picker offers does; 'xx' stands in for one that doesn't.
    resolveUiLocale: (code: string) => (code === 'xx' ? null : code),
}));

jest.mock('@/lib/i18n', () => ({
    previewLanguage: (...a: unknown[]) => mockPreviewLanguage(...a),
}));

jest.mock('@/lib/stores/app-language-store', () => {
    const useAppLanguageStore = (selector: (s: unknown) => unknown) =>
        selector({ appLanguage: mockAppLanguage, setAppLanguage: mockSetAppLanguage });
    useAppLanguageStore.getState = () => ({
        appLanguage: mockAppLanguage,
        setAppLanguage: mockSetAppLanguage,
    });
    return { useAppLanguageStore };
});

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockRemove = jest.fn();
jest.mock('react-native', () => ({
    Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
    BackHandler: {
        addEventListener: jest.fn(() => ({ remove: mockRemove })),
    },
}));

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { BackHandler } from 'react-native';
import { useLanguageSwitch } from '../use-language-switch';

/** Hand-resolved probe, so a test can hold one open indefinitely. */
function deferredProbe() {
    let resolve!: (v: string) => void;
    const promise = new Promise<string>((r) => { resolve = r; });
    mockProbe.mockReturnValueOnce(promise);
    return { resolve };
}

describe('useLanguageSwitch', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        mockAppLanguage = 'en';
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('does NOT touch the native module until the picker has finished dismissing', () => {
        const { result } = renderHook(() => useLanguageSwitch());

        act(() => result.current.requestSwitch('de'));

        // THE CRASH GUARD. Presenting Apple's sheet while the pageSheet modal
        // is still animating away is a native crash, so nothing may happen in
        // this window.
        expect(mockProbe).not.toHaveBeenCalled();
        expect(result.current.busy).toBe(true);
        expect(result.current.phase).toBe('awaiting-dismiss');

        act(() => result.current.notifyPickerDismissed());
        expect(mockProbe).toHaveBeenCalledWith('de');
        expect(result.current.phase).toBe('probing');
    });

    it('self-heals if the dismissal callback never arrives', () => {
        const { result } = renderHook(() => useLanguageSwitch());
        act(() => result.current.requestSwitch('de'));
        expect(mockProbe).not.toHaveBeenCalled();

        act(() => { jest.advanceTimersByTime(2000); });

        // A phase only a callback can leave would strand the user on a screen
        // whose back button is disabled.
        expect(mockProbe).toHaveBeenCalledWith('de');
    });

    it('commits the language only when the probe succeeds', async () => {
        const onCommitted = jest.fn();
        const { result } = renderHook(() => useLanguageSwitch({ onCommitted }));
        mockProbe.mockResolvedValueOnce('success');

        act(() => result.current.requestSwitch('de'));
        await act(async () => { result.current.notifyPickerDismissed(); });

        expect(mockSetAppLanguage).toHaveBeenCalledWith('de');
        expect(onCommitted).toHaveBeenCalledWith('de', 'en');
        await waitFor(() => expect(result.current.busy).toBe(false));
    });

    it('leaves the user on the PREVIOUS language when the probe fails', async () => {
        mockAppLanguage = 'fr';
        const onResult = jest.fn();
        const { result } = renderHook(() => useLanguageSwitch({ onResult }));
        mockProbe.mockResolvedValueOnce('failed');

        act(() => result.current.requestSwitch('de'));
        await act(async () => { result.current.notifyPickerDismissed(); });

        // Never applied, so there is nothing to roll back — and 'fr', not
        // 'en', is where the user stays.
        expect(mockSetAppLanguage).not.toHaveBeenCalled();
        expect(onResult).toHaveBeenCalledWith({
            code: 'de',
            outcome: 'failed',
            fellBackToEnglish: false,
        });
        await waitFor(() => expect(result.current.busy).toBe(false));
    });

    it('does not commit on timeout, and unlocks navigation', async () => {
        const onResult = jest.fn();
        const { result } = renderHook(() => useLanguageSwitch({ onResult }));
        mockProbe.mockResolvedValueOnce('timeout');

        act(() => result.current.requestSwitch('de'));
        await act(async () => { result.current.notifyPickerDismissed(); });

        expect(mockSetAppLanguage).not.toHaveBeenCalled();
        expect(onResult).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'timeout', fellBackToEnglish: false }),
        );
        await waitFor(() => expect(result.current.busy).toBe(false));
    });

    it('falls back to ENGLISH, not the previous language, when the DEVICE has no translator', async () => {
        mockAppLanguage = 'fr';
        const onResult = jest.fn();
        const onCommitted = jest.fn();
        const { result } = renderHook(() => useLanguageSwitch({ onResult, onCommitted }));
        mockProbe.mockResolvedValueOnce('device-unsupported');

        act(() => result.current.requestSwitch('de'));
        await act(async () => { result.current.notifyPickerDismissed(); });

        // English is the FINAL fallback, and this is the one case where it beats
        // "revert to the previous language": on a device with no translator at
        // all, 'fr' is exactly as untranslatable as 'de', so returning there
        // would be theatre. English is the source language of every
        // translatable string, so it is the one landing spot where nothing on
        // screen is waiting on a translator that does not exist.
        expect(mockSetAppLanguage).toHaveBeenCalledWith('en');
        expect(mockSetAppLanguage).not.toHaveBeenCalledWith('de');
        // Committed with the code that actually won, never the requested one —
        // the RTL restart prompt hangs off this pair.
        expect(onCommitted).toHaveBeenCalledWith('en', 'fr');
        expect(onResult).toHaveBeenCalledWith(
            expect.objectContaining({
                code: 'de',
                outcome: 'device-unsupported',
                fellBackToEnglish: true,
            }),
        );
    });

    it('cancel releases the screen immediately, without waiting on the native call', async () => {
        const onCommitted = jest.fn();
        const { result } = renderHook(() => useLanguageSwitch({ onCommitted }));
        const probe = deferredProbe();

        act(() => result.current.requestSwitch('de'));
        act(() => result.current.notifyPickerDismissed());
        expect(result.current.busy).toBe(true);

        act(() => result.current.cancel());

        // The escape hatch is the ONLY way out while a probe runs, so it must
        // never be gated on the promise that may hang.
        expect(result.current.busy).toBe(false);
        expect(result.current.pendingCode).toBeNull();

        // And an orphaned probe that lands later must not commit a language
        // the user has already backed out of.
        await act(async () => { probe.resolve('success'); });
        expect(mockSetAppLanguage).not.toHaveBeenCalled();
        expect(onCommitted).not.toHaveBeenCalled();
    });

    it('routes Android hardware back to cancel rather than swallowing it', () => {
        const { result } = renderHook(() => useLanguageSwitch());
        deferredProbe();

        act(() => result.current.requestSwitch('de'));
        act(() => result.current.notifyPickerDismissed());

        const handler = (BackHandler.addEventListener as jest.Mock).mock.calls.at(-1)?.[1];
        expect(handler).toBeInstanceOf(Function);

        let handled: boolean | undefined;
        act(() => { handled = handler(); });

        // Consumed (so it cannot pop the screen mid-probe) but NOT ignored —
        // a back press that appears to do nothing reads as a frozen phone.
        expect(handled).toBe(true);
        expect(result.current.busy).toBe(false);
    });

    it('ignores a re-tap of the language already in use', () => {
        mockAppLanguage = 'de';
        const { result } = renderHook(() => useLanguageSwitch());

        act(() => result.current.requestSwitch('de'));

        expect(result.current.busy).toBe(false);
        expect(mockProbe).not.toHaveBeenCalled();
    });

    // ── The UI language moves at SELECTION, and comes back on every loss ────
    //
    // The point of the whole arrangement: the progress card tells the user to
    // tap a download icon, and that instruction is worthless in a language they
    // cannot read. So the app switches immediately — which turns every losing
    // ending into a real revert rather than the no-op it used to be.

    it('previews the target language the moment it is picked, before any probe', () => {
        const { result } = renderHook(() => useLanguageSwitch());

        act(() => result.current.requestSwitch('de'));

        // Before the picker has even finished dismissing, and long before the
        // native call — the card must come up already in German.
        expect(mockPreviewLanguage).toHaveBeenCalledWith('de');
        expect(mockProbe).not.toHaveBeenCalled();
    });

    it('does NOT preview a language the app ships no strings for', () => {
        const { result } = renderHook(() => useLanguageSwitch());

        act(() => result.current.requestSwitch('xx'));

        // i18next has `fallbackLng: 'en'`, so previewing a bundle-less code
        // would silently drop the reader into English — worse than leaving
        // them where they were.
        expect(mockPreviewLanguage).not.toHaveBeenCalled();
    });

    it('puts the language back when the user backs out', () => {
        mockAppLanguage = 'fr';
        const { result } = renderHook(() => useLanguageSwitch());
        deferredProbe();

        act(() => result.current.requestSwitch('de'));
        act(() => result.current.notifyPickerDismissed());
        expect(mockPreviewLanguage).toHaveBeenLastCalledWith('de');

        act(() => result.current.cancel());

        // Cancel is a REAL revert now, not a no-op: the UI is already in
        // German and must be returned to French.
        expect(mockPreviewLanguage).toHaveBeenLastCalledWith('fr');
    });

    it('puts the language back when the probe fails', async () => {
        mockAppLanguage = 'fr';
        const { result } = renderHook(() => useLanguageSwitch());
        mockProbe.mockResolvedValueOnce('failed');

        act(() => result.current.requestSwitch('de'));
        await act(async () => { result.current.notifyPickerDismissed(); });

        expect(mockPreviewLanguage).toHaveBeenLastCalledWith('fr');
        expect(mockSetAppLanguage).not.toHaveBeenCalled();
    });

    it('puts the language back on timeout', async () => {
        mockAppLanguage = 'fr';
        const { result } = renderHook(() => useLanguageSwitch());
        mockProbe.mockResolvedValueOnce('timeout');

        act(() => result.current.requestSwitch('de'));
        await act(async () => { result.current.notifyPickerDismissed(); });

        expect(mockPreviewLanguage).toHaveBeenLastCalledWith('fr');
    });

    it('leaves the committed language in place on success', async () => {
        mockAppLanguage = 'fr';
        const { result } = renderHook(() => useLanguageSwitch());
        mockProbe.mockResolvedValueOnce('success');
        // `setAppLanguage` is what moves the store; mirror that here so the
        // teardown reads the committed value, exactly as it does in the app.
        mockSetAppLanguage.mockImplementationOnce(() => {
            mockAppLanguage = 'de';
            return Promise.resolve();
        });

        act(() => result.current.requestSwitch('de'));
        await act(async () => { result.current.notifyPickerDismissed(); });

        // The same teardown runs, but the store has moved, so re-applying it
        // is a no-op rather than a revert. No branching on the outcome.
        expect(mockPreviewLanguage).toHaveBeenLastCalledWith('de');
    });

    it('reverts to ENGLISH, not the previous language, when the device has no translator', async () => {
        mockAppLanguage = 'fr';
        const { result } = renderHook(() => useLanguageSwitch());
        mockProbe.mockResolvedValueOnce('device-unsupported');
        mockSetAppLanguage.mockImplementationOnce(() => {
            mockAppLanguage = 'en';
            return Promise.resolve();
        });

        act(() => result.current.requestSwitch('de'));
        await act(async () => { result.current.notifyPickerDismissed(); });

        expect(mockPreviewLanguage).toHaveBeenLastCalledWith('en');
    });

    it('a probe that lands AFTER a cancel cannot re-apply the abandoned language', async () => {
        mockAppLanguage = 'fr';
        const { result } = renderHook(() => useLanguageSwitch());
        const probe = deferredProbe();

        act(() => result.current.requestSwitch('de'));
        act(() => result.current.notifyPickerDismissed());
        act(() => result.current.cancel());
        expect(mockPreviewLanguage).toHaveBeenLastCalledWith('fr');

        // The user is already back on French. A late 'success' must not drag
        // them into German behind their back — this is a NEW way for the
        // orphaned-probe bug to show up, now that the language really moves.
        await act(async () => { probe.resolve('success'); });

        expect(mockSetAppLanguage).not.toHaveBeenCalled();
        expect(mockPreviewLanguage).toHaveBeenLastCalledWith('fr');
    });

    it('reverts when the screen is left mid-probe', () => {
        mockAppLanguage = 'fr';
        const { result, unmount } = renderHook(() => useLanguageSwitch());
        deferredProbe();

        act(() => result.current.requestSwitch('de'));
        act(() => result.current.notifyPickerDismissed());

        unmount();

        // The UI language is global — walking away from the screen must not
        // leave the whole app in a language that never committed. Unmount is a
        // separate exit that never calls `finish()`.
        expect(mockPreviewLanguage).toHaveBeenLastCalledWith('fr');
    });

    it('ignores a second request while one is already running', () => {
        const { result } = renderHook(() => useLanguageSwitch());
        deferredProbe();

        act(() => result.current.requestSwitch('de'));
        act(() => result.current.notifyPickerDismissed());
        act(() => result.current.requestSwitch('fr'));

        expect(mockProbe).toHaveBeenCalledTimes(1);
        expect(result.current.pendingCode).toBe('de');
    });
});
