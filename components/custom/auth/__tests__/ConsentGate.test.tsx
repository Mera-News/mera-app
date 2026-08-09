/* eslint-disable @typescript-eslint/no-require-imports */
// ConsentGate (B6, Item 2a) — verifies:
//  • renders nothing while the session is pending, unauthenticated, or the
//    server config hasn't resolved yet — never a flash of the blocking screen;
//  • renders the blocking screen when the session user's terms/privacy
//    versions are missing or mismatched against the server's current stamps;
//  • renders nothing once both versions already match;
//  • accepting POSTs the current versions and then STAYS accepted for the
//    rest of the session even if the next useSession() read still reports the
//    stale (pre-accept) versions — the exact race documented in the
//    component's header (better-auth-expo's persisted session cache has no
//    guarantee of reflecting a just-completed accept on the very next read);
//  • a failed accept shows the retry copy and does not latch acceptance.

import { act, fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import React from 'react';

// Pure decoration; keeps react-native-reanimated out of this suite's module
// graph (its worklets runtime cannot initialise under Jest). Same pattern as
// SecuritySettingsScreen.test.tsx.
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({
    __esModule: true,
    default: () => null,
}));

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string) => k }),
}));

// Gluestack UI primitives, mocked to plain RN elements — avoids pulling in
// react-native's ActivityIndicator (via ui/spinner) and its native-component
// spec file, which Jest's transform can't parse. Same approach as
// not-subscribed-exit.test.tsx.
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return {
        Button: (p: any) => <Pressable {...p} />,
        ButtonText: (p: any) => <Text {...p} />,
    };
});
jest.mock('@/components/ui/spinner', () => {
    const { View } = require('react-native');
    return { Spinner: (p: any) => <View {...p} /> };
});
// RN's real ScrollView pulls in an untransformed Android spec file under this
// jest config; the component reaches it through the ui layer, so one stub
// suffices — same pattern as not-subscribed-exit.test.tsx.
jest.mock('@/components/ui/scroll-view', () => {
    const { View } = require('react-native');
    return { ScrollView: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable: (p: any) => <Pressable {...p} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
    const { View } = require('react-native');
    return { VStack: (p: any) => <View {...p} /> };
});

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));

jest.mock('@/lib/web-browser-utils', () => ({
    openInAppBrowser: jest.fn(),
    withAppLanguage: (url: string) => url,
}));

jest.mock('@/lib/config/branding', () => ({
    TERMS_URL: 'https://mera.news/terms',
    PRIVACY_URL: 'https://mera.news/privacy',
}));

let mockSessionRef: { current: any } = { current: null };
let mockIsPending = false;
jest.mock('@/lib/auth-client', () => ({
    authClient: {
        useSession: () => ({ data: mockSessionRef.current, isPending: mockIsPending }),
    },
}));

const mockFetchLegalVersions = jest.fn();
const mockAcceptLegal = jest.fn();
const mockNeedsConsent = jest.fn();
jest.mock('../legal-consent', () => ({
    fetchLegalVersions: (...a: unknown[]) => mockFetchLegalVersions(...a),
    acceptLegal: (...a: unknown[]) => mockAcceptLegal(...a),
    needsConsent: (...a: unknown[]) => mockNeedsConsent(...a),
}));

import ConsentGate from '../ConsentGate';

const CURRENT = { termsVersion: '2026-08-01', privacyVersion: '2026-08-01' };

async function flush() {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

describe('ConsentGate', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockIsPending = false;
        mockSessionRef.current = { user: { id: 'user-1', termsVersion: null, privacyVersion: null } };
        mockFetchLegalVersions.mockResolvedValue(CURRENT);
        mockNeedsConsent.mockReturnValue(true);
    });

    it('renders nothing while the session is still pending', () => {
        mockIsPending = true;
        const { toJSON } = render(<ConsentGate />);
        expect(toJSON()).toBeNull();
    });

    it('renders nothing when there is no signed-in user', async () => {
        mockSessionRef.current = null;
        // The component has no independent "no user" short-circuit of its
        // own — it relies on needsConsent's own fail-open for a null user
        // (asserted directly in legal-consent.test.ts). Reflect that here.
        mockNeedsConsent.mockReturnValue(false);
        const { toJSON } = render(<ConsentGate />);
        await flush();
        expect(toJSON()).toBeNull();
    });

    it('renders nothing before the server appConfig has resolved (fails open)', async () => {
        mockFetchLegalVersions.mockReturnValue(new Promise(() => {})); // never resolves
        mockNeedsConsent.mockReturnValue(false); // current is null -> needsConsent's own fail-open
        const { toJSON } = render(<ConsentGate />);
        await flush();
        expect(toJSON()).toBeNull();
    });

    it('renders nothing when needsConsent says the versions already match', async () => {
        mockNeedsConsent.mockReturnValue(false);
        const { toJSON } = render(<ConsentGate />);
        await flush();
        expect(toJSON()).toBeNull();
    });

    it('renders the blocking screen when consent is needed', async () => {
        const { getByTestId } = render(<ConsentGate />);
        await flush();
        expect(getByTestId('consent-accept')).toBeTruthy();
    });

    // REGRESSION. This gate is an absolute overlay on top of a LIVE logged-in
    // tree, and AbstractGradientBackdrop is translucent everywhere and opaque
    // nowhere — so without an opaque fill of its own the screen behind it (the
    // paywall, in the reported case) reads straight through the consent copy and
    // the whole thing looks like a popup over another page. Asserting the fill
    // exists AND is actually opaque is the only way that regression is visible
    // outside a screenshot.
    it('paints an opaque full-bleed base so the screen behind it cannot show through', async () => {
        const { getByTestId } = render(<ConsentGate />);
        await flush();

        const fill = getByTestId('consent-backdrop-fill');
        const style = StyleSheet.flatten(fill.props.style) as {
            backgroundColor?: string;
            position?: string;
            opacity?: number;
        };
        expect(style.backgroundColor).toBe('#000000');
        expect(style.position).toBe('absolute');
        // An explicit opacity below 1 would defeat the fill while leaving the
        // colour assertion above green.
        expect(style.opacity ?? 1).toBe(1);
    });

    it('fetches the server appConfig once a signed-in user is present', async () => {
        render(<ConsentGate />);
        await flush();
        expect(mockFetchLegalVersions).toHaveBeenCalled();
    });

    it('POSTs the fetched versions on accept', async () => {
        mockAcceptLegal.mockResolvedValue({ ok: true });
        const { getByTestId } = render(<ConsentGate />);
        await flush();

        fireEvent.press(getByTestId('consent-accept'));
        await flush();

        expect(mockAcceptLegal).toHaveBeenCalledWith(CURRENT);
    });

    it('stays accepted (renders nothing) after a successful accept, even if the session still reports stale versions', async () => {
        mockAcceptLegal.mockResolvedValue({ ok: true });
        const { getByTestId, toJSON, queryByTestId } = render(<ConsentGate />);
        await flush();
        expect(getByTestId('consent-accept')).toBeTruthy();

        fireEvent.press(getByTestId('consent-accept'));
        await flush();

        // needsConsent would still say "true" here (mock unchanged, simulating
        // authClient.useSession()'s cached session_data not yet reflecting the
        // accept) — the local `accepted` latch must override it regardless.
        expect(mockNeedsConsent).toHaveBeenCalled();
        expect(queryByTestId('consent-accept')).toBeNull();
        expect(toJSON()).toBeNull();
    });

    it('shows the retry state and does NOT latch acceptance when the accept call fails', async () => {
        mockAcceptLegal.mockResolvedValue({ ok: false });
        const { getByTestId } = render(<ConsentGate />);
        await flush();

        fireEvent.press(getByTestId('consent-accept'));
        await flush();

        // Still shown — the gate did not stand down on a failed accept.
        expect(getByTestId('consent-accept')).toBeTruthy();
    });

    it('resets the accepted latch when the signed-in user changes', async () => {
        mockAcceptLegal.mockResolvedValue({ ok: true });
        const { getByTestId, queryByTestId, rerender } = render(<ConsentGate />);
        await flush();
        fireEvent.press(getByTestId('consent-accept'));
        await flush();
        expect(queryByTestId('consent-accept')).toBeNull();

        // A different account signs in.
        mockSessionRef.current = { user: { id: 'user-2', termsVersion: null, privacyVersion: null } };
        rerender(<ConsentGate />);
        await flush();

        expect(getByTestId('consent-accept')).toBeTruthy();
    });
});
