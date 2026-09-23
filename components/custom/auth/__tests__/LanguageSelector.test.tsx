/**
 * The RTL restart prompt goes through the one restart authority.
 *
 * This was the LAST of the four ad-hoc `Updates.reloadAsync()` callers. A bare
 * reload here bypasses every gate in `lib/app-restart.ts`, including the
 * `purchase` hold, so it could reload the app out of a checkout that was
 * mid-flight on another screen. The other three are already migrated, which is
 * exactly what makes a fourth easy to miss.
 *
 * Mocked to the bone. The component mounts a reanimated carousel, Gluestack's
 * provider and an RN Modal; rendering any of them here costs the Worklets
 * import error for no assertion. `handleCommitted` is lifted out through the
 * `useLanguageSwitch` mock and called directly, which is the whole surface
 * under test.
 */

const mockRequestRestart = jest.fn();
jest.mock('@/lib/app-restart', () => ({
    requestRestart: (reason: string) => mockRequestRestart(reason),
}));

// If this ever resolves to the real module, the assertion below stops meaning
// anything: the component would reload for real and `expo-updates` is exactly
// what must no longer be reachable from this file.
const mockReloadAsync = jest.fn();
jest.mock('expo-updates', () => ({ reloadAsync: (...a: unknown[]) => mockReloadAsync(...a) }));

let committed: ((code: string, previousCode: string) => void) | null = null;
jest.mock('@/lib/hooks/use-language-switch', () => ({
    useLanguageSwitch: (opts: { onCommitted: (c: string, p: string) => void }) => {
        committed = opts.onCommitted;
        return {
            pendingCode: null,
            busy: false,
            requestSwitch: jest.fn(),
            notifyPickerDismissed: jest.fn(),
            cancel: jest.fn(),
        };
    },
}));

// RN's Modal pulls an untransformed native spec in jest and dies at import.
// Same recipe as LegalFooter's and FeedbackTreeOverlay's suites: render the
// children straight through. The picker sheet is not what is under test.
jest.mock('react-native/Libraries/Modal/Modal', () => ({
    __esModule: true,
    default: (props: { visible?: boolean; children?: React.ReactNode }) =>
        props.visible === false ? null : props.children,
}));
jest.mock('react-native-reanimated-carousel', () => ({ __esModule: true, default: () => null }));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/components/ui/gluestack-ui-provider', () => ({
    GluestackUIProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/custom/config-mera/LanguageSwitchProgress', () => ({
    __esModule: true,
    default: () => null,
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/lib/stores/app-language-store', () => ({
    useAppLanguageStore: Object.assign(
        (selector: (s: { appLanguage: string }) => unknown) => selector({ appLanguage: 'en' }),
        { getState: () => ({ appLanguage: 'en' }) },
    ),
}));
jest.mock('@/lib/translation-service', () => ({
    SUPPORTED_LANGUAGES: [{ code: 'en', name: 'English', native: 'English' }],
    getLanguageName: (c: string) => c,
}));

import { Alert } from 'react-native';
import { render } from '@testing-library/react-native';
import React from 'react';

import LanguageSelector from '../LanguageSelector';

type AlertButton = { text: string; onPress?: () => void };

/** Mounts the component and returns the RTL alert's "Restart" button. */
function restartButton(): AlertButton {
    const spy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<LanguageSelector />);
    // ltr -> rtl, the one transition that raises the prompt at all.
    committed?.('ar', 'en');
    const buttons = spy.mock.calls[0][2] as AlertButton[];
    const restart = buttons.find((b) => b.text === 'language.restart');
    if (!restart) throw new Error('no restart button in the RTL alert');
    return restart;
}

beforeEach(() => {
    jest.clearAllMocks();
    committed = null;
});

it('routes the RTL restart through requestRestart, never a bare reloadAsync', () => {
    restartButton().onPress?.();

    expect(mockRequestRestart).toHaveBeenCalledWith('language');
    expect(mockReloadAsync).not.toHaveBeenCalled();
});

// Non-vacuity: the assertion above would pass just as happily if the alert
// never rendered or the button were never found.
it('raises the prompt only when the switch crosses the RTL boundary', () => {
    const spy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    render(<LanguageSelector />);

    committed?.('fr', 'en');
    expect(spy).not.toHaveBeenCalled();

    committed?.('ar', 'en');
    expect(spy).toHaveBeenCalledTimes(1);
});
