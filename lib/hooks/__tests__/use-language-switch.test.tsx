// The language-switch state machine.
//
// Everything here is behaviour the simulator cannot show, because on-device
// translation never succeeds there — so these specs are the only evidence for
// the cancel, timeout and navigation-lock paths.

const mockProbe = jest.fn();
const mockSetAppLanguage = jest.fn(() => Promise.resolve());
let mockAppLanguage = 'en';

jest.mock('@/lib/translation-service', () => ({
    probeTranslationLanguage: (...a: unknown[]) => mockProbe(...a),
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
            committedAnyway: false,
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
            expect.objectContaining({ outcome: 'timeout', committedAnyway: false }),
        );
        await waitFor(() => expect(result.current.busy).toBe(false));
    });

    it('applies the language anyway when the DEVICE has no translator', async () => {
        const onResult = jest.fn();
        const { result } = renderHook(() => useLanguageSwitch({ onResult }));
        mockProbe.mockResolvedValueOnce('device-unsupported');

        act(() => result.current.requestSwitch('de'));
        await act(async () => { result.current.notifyPickerDismissed(); });

        // Reverting would be nonsense here: the previous language is equally
        // untranslatable, so refusing would make the UI language permanently
        // unchangeable on this device.
        expect(mockSetAppLanguage).toHaveBeenCalledWith('de');
        expect(onResult).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'device-unsupported', committedAnyway: true }),
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
