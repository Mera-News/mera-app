/* eslint-disable @typescript-eslint/no-require-imports */
// AuthScreen.welcome.test.tsx — the staged pre-auth flow (S13 redesign).
//
// What must hold:
//  - A device that has NEVER explicitly picked a language (no `app_language`
//    settings row) lands on the LANGUAGE stage first; Continue persists the
//    preselected value through setAppLanguage and advances to the welcome
//    view. With the row present, welcome renders directly. A remembered
//    previous user outranks both; no attestation falls straight to email.
//  - "Get started" advances to the CONSENT step; the device sign-in runs from
//    "Agree and continue" there, mirroring OTPVerificationView's bookkeeping:
//    recordAuthenticatedUser BEFORE navigation, needsReauth cleared, identity
//    fault cleared, and the just-given consent stamped via acceptLegal (latch
//    marked only when the stamp lands).
//  - Every failure state offers retry AND the email path, and retry re-runs
//    the whole flow (fresh nonce lives inside signInWithDevice).

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/auth/OTPVerificationView', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="stub-otp-view" /> };
});
jest.mock('@/components/custom/auth/PreviousUserView', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="stub-previous-user-view" /> };
});
jest.mock('@/components/custom/auth/LanguageSelector', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="stub-language-selector" /> };
});
jest.mock('@/components/custom/auth/LegalFooter', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="stub-legal-footer" /> };
});
jest.mock('@/components/custom/tutorials/TutorialLaunchButton', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="stub-tutorial-launch" /> };
});
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable: (p: any) => <Pressable {...p} /> };
});
jest.mock('@/components/ui/input', () => {
    const { View, TextInput } = require('react-native');
    return { Input: (p: any) => <View {...p} />, InputField: (p: any) => <TextInput {...p} /> };
});
jest.mock('@/components/ui/toast', () => {
    const { View, Text } = require('react-native');
    return {
        Toast: (p: any) => <View {...p} />,
        ToastTitle: (p: any) => <Text {...p} />,
        ToastDescription: (p: any) => <Text {...p} />,
        useToast: () => ({ show: jest.fn() }),
    };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} />, FontAwesome: (p: any) => <View {...p} /> };
});
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const mockRouterReplace = jest.fn();
const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
    router: {
        replace: (...a: any[]) => mockRouterReplace(...a),
        push: (...a: any[]) => mockRouterPush(...a),
    },
}));

const mockGetSetting = jest.fn();
jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (k: string) => mockGetSetting(k),
}));

const mockAvailability = jest.fn();
const mockSignIn = jest.fn();
jest.mock('@/lib/device-auth', () => ({
    deviceSignInAvailability: (...a: any[]) => mockAvailability(...a),
    signInWithDevice: (...a: any[]) => mockSignIn(...a),
}));

jest.mock('@/lib/auth-client', () => ({
    sendOTP: jest.fn(async () => ({ success: true })),
}));

const mockRecordAuthenticatedUser = jest.fn();
const mockClearIdentityFault = jest.fn(async (..._a: unknown[]) => {});
jest.mock('@/lib/security/identity-gate', () => ({
    recordAuthenticatedUser: (...a: any[]) => mockRecordAuthenticatedUser(...a),
    clearIdentityFault: (...a: any[]) => mockClearIdentityFault(...a),
}));

const mockSetNeedsReauth = jest.fn();
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: { getState: () => ({ setNeedsReauth: mockSetNeedsReauth }) },
}));

// The store's getState is read twice by the language stage (current value +
// the persist call); a plain object with a stable jest.fn is enough.
const mockSetAppLanguage = jest.fn(async (_lang: string) => {});
jest.mock('@/lib/stores/app-language-store', () => ({
    useAppLanguageStore: {
        getState: () => ({ appLanguage: 'en', setAppLanguage: mockSetAppLanguage }),
    },
}));

const mockFetchLegalVersions = jest.fn();
const mockAcceptLegal = jest.fn();
const mockMarkAccepted = jest.fn();
const mockSilentlyAcceptLegal = jest.fn(async (..._a: any[]) => {});
jest.mock('../legal-consent', () => ({
    fetchLegalVersions: (...a: any[]) => mockFetchLegalVersions(...a),
    acceptLegal: (...a: any[]) => mockAcceptLegal(...a),
    markLegalAcceptedThisProcess: (...a: any[]) => mockMarkAccepted(...a),
    silentlyAcceptLegal: (...a: any[]) => mockSilentlyAcceptLegal(...a),
}));

const mockOpenSupport = jest.fn();
jest.mock('@/lib/intercom', () => ({
    useSupportAction: () => ({ busy: false, openSupport: mockOpenSupport }),
}));

jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn(async () => {}) }));
jest.mock('@/lib/web-browser-utils', () => ({
    openInAppBrowser: jest.fn(),
    withAppLanguage: (u: string) => u,
}));
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn(), debug: jest.fn() },
}));

import AuthScreen from '../AuthScreen';

const CURRENT = { termsVersion: '2026-08-01', privacyVersion: '2026-08-01' };

beforeEach(() => {
    jest.clearAllMocks();
    // Default: language already chosen (the row exists) — most tests start on
    // the welcome view. The language-stage cases override to null.
    mockGetSetting.mockImplementation(async (k: string) =>
        k === 'app_language' ? 'en' : null,
    );
    mockAvailability.mockResolvedValue('native');
    mockFetchLegalVersions.mockResolvedValue(CURRENT);
    mockAcceptLegal.mockResolvedValue({ ok: true });
});

/** Press "Get started" on the welcome view, landing on the consent step. */
async function advanceToConsent(r: ReturnType<typeof render>) {
    fireEvent.press(await r.findByTestId('auth-get-started'));
    return r.findByTestId('auth-consent-agree');
}

describe('entry view selection', () => {
    it('a device that never picked a language lands on the LANGUAGE stage', async () => {
        mockGetSetting.mockResolvedValue(null); // no app_language row
        const { findByTestId, queryByTestId } = render(<AuthScreen />);
        expect(await findByTestId('auth-language-continue')).toBeTruthy();
        expect(queryByTestId('auth-get-started')).toBeNull();
        expect(queryByTestId('stub-language-selector')).toBeTruthy();
    });

    it('with the app_language row present, welcome renders directly (no language stage)', async () => {
        const { findByTestId, queryByTestId } = render(<AuthScreen />);
        expect(await findByTestId('auth-get-started')).toBeTruthy();
        expect(queryByTestId('auth-language-continue')).toBeNull();
        expect(queryByTestId('auth-email-input')).toBeNull();
    });

    it('no attestation and no dev token falls straight to the email view', async () => {
        mockAvailability.mockResolvedValue('unavailable');
        const { findByTestId, queryByTestId } = render(<AuthScreen />);
        expect(await findByTestId('auth-email-input')).toBeTruthy();
        expect(queryByTestId('auth-get-started')).toBeNull();
    });

    it('a remembered previous user outranks the welcome view', async () => {
        mockGetSetting.mockImplementation(async (k: string) =>
            k === 'cached_user_email' ? 'a@b.com' : k === 'cached_user_id' ? 'u1' : 'en',
        );
        const { queryByTestId, findByTestId } = render(<AuthScreen />);
        expect(await findByTestId('stub-previous-user-view')).toBeTruthy();
        expect(queryByTestId('auth-get-started')).toBeNull();
    });
});

describe('language stage (S13)', () => {
    it('Continue persists the preselected language through setAppLanguage, then advances to welcome', async () => {
        mockGetSetting.mockResolvedValue(null);
        const { findByTestId } = render(<AuthScreen />);

        fireEvent.press(await findByTestId('auth-language-continue'));

        expect(await findByTestId('auth-get-started')).toBeTruthy();
        expect(mockSetAppLanguage).toHaveBeenCalledWith('en');
    });

    it('still advances (once, next launch re-asks) when the persist throws', async () => {
        mockGetSetting.mockResolvedValue(null);
        mockSetAppLanguage.mockRejectedValueOnce(new Error('db closed'));
        const { findByTestId } = render(<AuthScreen />);

        fireEvent.press(await findByTestId('auth-language-continue'));

        expect(await findByTestId('auth-get-started')).toBeTruthy();
    });

    it('the language stage shows no welcome actions and no footer chrome', async () => {
        mockGetSetting.mockResolvedValue(null);
        const { findByTestId, queryByTestId } = render(<AuthScreen />);
        await findByTestId('auth-language-continue');
        expect(queryByTestId('auth-learn-mera')).toBeNull();
        expect(queryByTestId('auth-use-email')).toBeNull();
        expect(queryByTestId('stub-legal-footer')).toBeNull();
    });
});

describe('accessibility scoping (F2)', () => {
    it('exactly ONE node carries the Get started label, and it is the button itself', async () => {
        const { findByTestId, UNSAFE_root } = render(<AuthScreen />);
        const cta = await findByTestId('auth-get-started');

        expect(cta.props.accessibilityRole).toBe('button');
        expect(cta.props.accessibilityLabel).toBe('auth.getStarted');

        // Walk the rendered tree: no OTHER HOST node may carry the label — a
        // wrapper carrying it is the full-screen phantom button VoiceOver and
        // text-based automation both hit. Host nodes only (`type` is a
        // string): composite layers of the same pressable legitimately relay
        // the prop on its way to the single host view.
        const labelled: unknown[] = [];
        const walk = (node: any) => {
            if (
                typeof node?.type === 'string' &&
                node?.props?.accessibilityLabel === 'auth.getStarted'
            ) {
                labelled.push(node);
            }
            (node?.children ?? []).forEach((c: any) => typeof c === 'object' && walk(c));
        };
        walk(UNSAFE_root);
        expect(labelled).toHaveLength(1);
    });

    it('the full-screen wrappers are explicitly not accessibility elements', async () => {
        const { findByTestId } = render(<AuthScreen />);
        // auth-welcome-screen is the AuthScreen-side outer Box — on-device it
        // was the deepest of the phantom full-screen "Get started" Others
        // (plain RN container views answer an AGGREGATED accessibilityLabel);
        // the explicit accessible={false} marking is what stops that, proven
        // on-device by auth-welcome-root going label-less after the same fix.
        for (const id of [
            'auth-welcome-screen',
            'auth-welcome-root',
            'auth-welcome-logo-band',
            'auth-welcome-actions',
        ]) {
            const wrapper = await findByTestId(id);
            expect(wrapper.props.accessible).toBe(false);
            expect(wrapper.props.accessibilityLabel).toBeUndefined();
        }
    });

    it('the consent-step wrappers are scoped the same way', async () => {
        const r = render(<AuthScreen />);
        await advanceToConsent(r);
        for (const id of ['auth-consent-screen', 'auth-consent-root', 'auth-consent-cluster']) {
            const wrapper = await r.findByTestId(id);
            expect(wrapper.props.accessible).toBe(false);
            expect(wrapper.props.accessibilityLabel).toBeUndefined();
        }
    });

    it('the secondary failure controls are buttons with their own labels', async () => {
        mockSignIn.mockResolvedValue({ status: 'failed', reason: 'attestation-denied' });
        const r = render(<AuthScreen />);
        fireEvent.press(await advanceToConsent(r));
        await r.findByText('auth.deviceSignInDenied');

        // (The support control left this cluster 2026-08-19 — it lives on
        // the welcome-back screen now, as an icon-only circle.)
        for (const [id, label] of [
            ['auth-device-retry', 'auth.tryAgain'],
            ['auth-use-email-failure', 'auth.alreadyHaveAccount'],
        ] as const) {
            const node = await r.findByTestId(id);
            expect(node.props.accessibilityRole).toBe('button');
            expect(node.props.accessibilityLabel).toBe(label);
        }
    });
});

describe('welcome-view action stack (S13)', () => {
    /** Host testIDs in render order — the order assertion for the stack. */
    const collectTestIds = (root: any): string[] => {
        const ids: string[] = [];
        const walk = (node: any) => {
            if (typeof node?.type === 'string' && node?.props?.testID) ids.push(node.props.testID);
            (node?.children ?? []).forEach((c: any) => typeof c === 'object' && walk(c));
        };
        walk(root);
        return ids;
    };

    it('order is learn -> get started -> sign-in link, hints above their buttons', async () => {
        const { findByTestId, findByText, UNSAFE_root } = render(<AuthScreen />);
        const learn = await findByTestId('auth-learn-mera');
        const cta = await findByTestId('auth-get-started');

        const ids = collectTestIds(UNSAFE_root);
        expect(ids.indexOf('auth-learn-mera')).toBeGreaterThanOrEqual(0);
        expect(ids.indexOf('auth-learn-mera')).toBeLessThan(ids.indexOf('auth-get-started'));
        expect(ids.indexOf('auth-get-started')).toBeLessThan(ids.indexOf('auth-use-email'));

        // The three hint lines render.
        expect(await findByText('auth.firstTimeHint')).toBeTruthy();
        expect(await findByText('auth.readyHint')).toBeTruthy();
        expect(await findByText('auth.paidUserHint')).toBeTruthy();

        // Outline vs filled: same geometry (h-14 rounded-full), different fill.
        expect(learn.props.className).toContain('h-14');
        expect(learn.props.className).toContain('border');
        expect(learn.props.className).not.toContain('bg-primary-500');
        expect(cta.props.className).toContain('h-14');
        expect(cta.props.className).toContain('bg-primary-500');

        expect(learn.props.accessibilityRole).toBe('button');
        expect(learn.props.accessibilityLabel).toBe('auth.learnAboutMera');
    });

    it('Learn about Mera opens the tutorials MENU route, not a chapter', async () => {
        const { findByTestId } = render(<AuthScreen />);
        fireEvent.press(await findByTestId('auth-learn-mera'));
        expect(mockRouterPush).toHaveBeenCalledWith('/tutorials');
    });

    it('the footer tour pill stays off the welcome view but on the email view', async () => {
        const welcome = render(<AuthScreen />);
        await welcome.findByTestId('auth-get-started');
        expect(welcome.queryByTestId('stub-tutorial-launch')).toBeNull();
        welcome.unmount();

        mockAvailability.mockResolvedValue('unavailable');
        const email = render(<AuthScreen />);
        await email.findByTestId('auth-email-input');
        expect(email.queryByTestId('stub-tutorial-launch')).toBeTruthy();
    });

    it('no language selector on the welcome view; the legal footer renders', async () => {
        const { findByTestId, queryByTestId } = render(<AuthScreen />);
        await findByTestId('auth-get-started');
        expect(queryByTestId('stub-language-selector')).toBeNull();
        expect(queryByTestId('stub-legal-footer')).toBeTruthy();
    });

    it('the sign-in action is an OUTLINE button labeled Sign in and opens the email view', async () => {
        const { findByTestId } = render(<AuthScreen />);
        const signIn = await findByTestId('auth-use-email');
        expect(signIn.props.accessibilityRole).toBe('button');
        expect(signIn.props.accessibilityLabel).toBe('auth.signIn');
        // Same geometry as Learn about Mera; the filled CTA between them stays
        // the only primary.
        expect(signIn.props.className).toContain('h-14');
        expect(signIn.props.className).toContain('border');
        expect(signIn.props.className).not.toContain('bg-primary-500');

        fireEvent.press(signIn);
        expect(await findByTestId('auth-email-input')).toBeTruthy();
    });
});

describe('consent step (S13)', () => {
    it('Get started advances to the consent step — no sign-in yet', async () => {
        const r = render(<AuthScreen />);
        const agree = await advanceToConsent(r);
        expect(agree).toBeTruthy();
        expect(mockSignIn).not.toHaveBeenCalled();
        // The one-decision page: title, body, both policy links.
        expect(await r.findByText('consent.welcomeTitle')).toBeTruthy();
        expect(await r.findByText('consent.welcomeBody')).toBeTruthy();
        expect(await r.findByText('consent.termsLink')).toBeTruthy();
        expect(await r.findByText('consent.privacyLink')).toBeTruthy();
    });

    it('Agree and continue runs the device sign-in and stamps the acceptance AFTER the session exists', async () => {
        mockSignIn.mockResolvedValue({
            status: 'success',
            userId: 'anon-user-1',
            trialAvailable: true,
            welcomeBack: false,
        });
        const r = render(<AuthScreen />);

        const agree = await advanceToConsent(r);
        // No prefetch: appConfig requires a session, so a mount-time fetch
        // 401s pre-auth (e2e-proven on staging) and silently dropped the
        // stamp + latch — the exact overlay-flash bug this ordering fixes.
        expect(mockFetchLegalVersions).not.toHaveBeenCalled();
        fireEvent.press(agree);

        await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/logged-in'));
        expect(mockFetchLegalVersions.mock.invocationCallOrder[0]).toBeGreaterThan(
            mockSignIn.mock.invocationCallOrder[0],
        );
        expect(mockAcceptLegal).toHaveBeenCalledWith(CURRENT);
        expect(mockMarkAccepted).toHaveBeenCalledWith('anon-user-1');
    });

    it('a failed stamp does NOT mark the latch (ConsentGate re-asks) but still navigates', async () => {
        mockAcceptLegal.mockResolvedValue({ ok: false });
        mockSignIn.mockResolvedValue({
            status: 'success',
            userId: 'anon-user-1',
            trialAvailable: true,
            welcomeBack: false,
        });
        const r = render(<AuthScreen />);

        fireEvent.press(await advanceToConsent(r));

        await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/logged-in'));
        expect(mockMarkAccepted).not.toHaveBeenCalled();
    });

    it('a failed versions fetch (null) skips the stamp entirely and still signs in', async () => {
        mockFetchLegalVersions.mockResolvedValue(null); // fetch failed, fail-open
        mockSignIn.mockResolvedValue({
            status: 'success',
            userId: 'anon-user-1',
            trialAvailable: true,
            welcomeBack: false,
        });
        const r = render(<AuthScreen />);

        fireEvent.press(await advanceToConsent(r));

        await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/logged-in'));
        expect(mockAcceptLegal).not.toHaveBeenCalled();
        expect(mockMarkAccepted).not.toHaveBeenCalled();
    });
});

describe('device sign-in success', () => {
    it('records the user, clears reauth state and navigates to /logged-in', async () => {
        mockSignIn.mockResolvedValue({
            status: 'success',
            userId: 'anon-user-1',
            trialAvailable: true,
            welcomeBack: false,
        });
        const r = render(<AuthScreen />);

        fireEvent.press(await advanceToConsent(r));

        await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/logged-in'));
        expect(mockRecordAuthenticatedUser).toHaveBeenCalledWith('anon-user-1');
        expect(mockSetNeedsReauth).toHaveBeenCalledWith(false);
        expect(mockClearIdentityFault).toHaveBeenCalled();
        // The recording must precede navigation — it is what the gates read
        // while the session atom is still settling.
        expect(mockRecordAuthenticatedUser.mock.invocationCallOrder[0]).toBeLessThan(
            mockRouterReplace.mock.invocationCallOrder[0],
        );
    });

    it('S10: welcomeBack true routes to the dedicated welcome-back screen, never /logged-in', async () => {
        mockSignIn.mockResolvedValue({
            status: 'success',
            userId: 'anon-user-2',
            trialAvailable: false,
            welcomeBack: true,
        });
        const r = render(<AuthScreen />);

        fireEvent.press(await advanceToConsent(r));

        await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith('/welcome-back'));
        expect(mockRouterReplace).not.toHaveBeenCalledWith('/logged-in');
        // Bookkeeping is identical either way.
        expect(mockRecordAuthenticatedUser).toHaveBeenCalledWith('anon-user-2');
    });

    it('reauth mode hands the userId to onLoginSuccess instead of navigating', async () => {
        mockSignIn.mockResolvedValue({
            status: 'success',
            userId: 'anon-user-1',
            trialAvailable: true,
            welcomeBack: false,
        });
        const onLoginSuccess = jest.fn();
        const r = render(<AuthScreen onLoginSuccess={onLoginSuccess} />);

        fireEvent.press(await advanceToConsent(r));

        await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledWith('anon-user-1'));
        expect(mockRouterReplace).not.toHaveBeenCalled();
    });
});

describe('device sign-in failure', () => {
    it('denied shows the denied copy with retry and the email escape', async () => {
        mockSignIn.mockResolvedValue({ status: 'failed', reason: 'attestation-denied' });
        const r = render(<AuthScreen />);

        fireEvent.press(await advanceToConsent(r));

        await r.findByText('auth.deviceSignInDenied');
        expect(await r.findByTestId('auth-device-retry')).toBeTruthy();
        expect(await r.findByTestId('auth-use-email-failure')).toBeTruthy();
    });

    it('retry re-runs the WHOLE flow (a fresh signInWithDevice call)', async () => {
        mockSignIn.mockResolvedValue({ status: 'failed', reason: 'network' });
        const r = render(<AuthScreen />);

        fireEvent.press(await advanceToConsent(r));
        fireEvent.press(await r.findByTestId('auth-device-retry'));

        await waitFor(() => expect(mockSignIn).toHaveBeenCalledTimes(2));
    });

    it('the failure state keeps its email escape', async () => {
        mockSignIn.mockResolvedValue({ status: 'failed', reason: 'attestation-denied' });
        const r = render(<AuthScreen />);
        fireEvent.press(await advanceToConsent(r));
        await r.findByText('auth.deviceSignInDenied');

        fireEvent.press(await r.findByTestId('auth-use-email-failure'));
        expect(await r.findByTestId('auth-email-input')).toBeTruthy();
    });

    it('unsupported mid-flow falls back to the email view silently', async () => {
        mockSignIn.mockResolvedValue({ status: 'unsupported' });
        const r = render(<AuthScreen />);

        fireEvent.press(await advanceToConsent(r));

        expect(await r.findByTestId('auth-email-input')).toBeTruthy();
    });
});

describe('email path consent', () => {
    it('OTP verification success silently stamps consent instead of prompting', async () => {
        mockAvailability.mockResolvedValue('unavailable');
        // Reach into the stubbed OTP view path indirectly: the handler is
        // AuthScreen's, so drive it through the email view's onOTPSent →
        // handleVerificationSuccess chain via the stub's props.
        const otpModule = jest.requireMock('@/components/custom/auth/OTPVerificationView');
        // `any`: assigned from inside the stub component's render, which TS
        // cannot see, so a typed declaration narrows to `never` at the call.
        let capturedOnSuccess: any = null;
        otpModule.default = (p: any) => {
            capturedOnSuccess = p.onVerificationSuccess;
            const { View } = require('react-native');
            return <View testID="stub-otp-view" />;
        };

        const onLoginSuccess = jest.fn();
        const r = render(<AuthScreen onLoginSuccess={onLoginSuccess} />);
        const emailInput = await r.findByTestId('auth-email-input');
        fireEvent.changeText(emailInput, 'a@b.com');
        fireEvent.press(await r.findByTestId('auth-send-otp'));
        await r.findByTestId('stub-otp-view');

        capturedOnSuccess?.('email-user-1');
        expect(mockSilentlyAcceptLegal).toHaveBeenCalledWith('email-user-1');
        expect(onLoginSuccess).toHaveBeenCalledWith('email-user-1');
    });
});
