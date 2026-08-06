/* eslint-disable @typescript-eslint/no-require-imports */
// FeedbackWidgetModal — identity on a bug report is LOCAL-first.
//
// A bug report is most likely to be filed when something is already wrong,
// which is exactly when /get-session is least likely to answer. Reading the id
// and email off the session meant those reports — the ones we can least afford
// to lose — arrived with no Sentry user id and an empty email box. Identity is
// a LOCAL fact (lib/security/launch-route.ts); the same rule Settings already
// applies in config-mera/AppPreferencesTab.
import { render } from '@testing-library/react-native';
import React from 'react';

// RN's real Modal/ScrollView pull untranspiled native view configs into this
// Jest env — replace the module with host elements, the same shape
// explore/__tests__/ScopeArticleList.test.tsx uses.
jest.mock('react-native', () => {
    const ReactLib = require('react');
    const host = (name: string) => (props: any) => ReactLib.createElement(name, props, props.children);
    return {
        __esModule: true,
        View: host('View'),
        Text: host('Text'),
        Pressable: host('Pressable'),
        Modal: (props: any) => (props.visible ? ReactLib.createElement('Modal', props, props.children) : null),
        ScrollView: host('ScrollView'),
        KeyboardAvoidingView: host('KeyboardAvoidingView'),
        Platform: { OS: 'ios', select: (o: any) => o.ios },
        StyleSheet: { create: (s: any) => s, flatten: (s: any) => s, absoluteFill: {} },
        useWindowDimensions: () => ({ width: 390, height: 844 }),
    };
});

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});
jest.mock('expo-application', () => ({ nativeApplicationVersion: '1.0.0', nativeBuildVersion: '1' }));
jest.mock('expo-updates', () => ({
    updateId: null, channel: 'production', runtimeVersion: '1.0.0', isEmbeddedLaunch: true,
}));

// The Sentry widget itself is the surface under test only insofar as it is
// handed an email to prefill — stub it and record the props.
const mockWidgetProps = { current: null as any };
jest.mock('@sentry/react-native', () => {
    const ReactLib = require('react');
    return {
        FeedbackWidget: (p: any) => { mockWidgetProps.current = p; return ReactLib.createElement('FeedbackWidget', null); },
        setUser: jest.fn(),
        setContext: jest.fn(),
        setTag: jest.fn(),
    };
});
jest.mock('@/lib/sentry-init', () => ({ SENTRY_ENABLED: true }));

jest.mock('@/lib/stores/feedback-store', () => ({
    useFeedbackVisible: () => true,
    useFeedbackStore: (sel: any) => sel({ hide: jest.fn() }),
}));
jest.mock('@/lib/stores/app-language-store', () => ({
    useAppLanguageStore: { getState: () => ({ appLanguage: 'en' }) },
}));
jest.mock('@/lib/stores/subscription-store', () => ({
    useSubscriptionStore: { getState: () => ({ tier: 'starter', isPremium: false }) },
}));
jest.mock('@/lib/stores/mera-protocol-store', () => ({
    useMeraProtocolStore: { getState: () => ({ processingMode: 'cloud', modelState: 'ready' }) },
}));

const mockSessionRef = {
    current: { user: { id: 'u1', email: 'session@example.com' } } as
        | { user: { id: string; email: string } }
        | null,
};
jest.mock('@/lib/auth-client', () => ({
    authClient: { useSession: () => ({ data: mockSessionRef.current }) },
}));

// Selector-shaped — the component reads userId and userEmail off the store.
const mockLocalRef = { current: { userId: 'u1', userEmail: 'local@example.com' } as any };
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: (selector?: (s: unknown) => unknown) =>
        (selector ? selector(mockLocalRef.current) : mockLocalRef.current),
}));

import FeedbackWidgetModal from '../FeedbackWidgetModal';

const Sentry = require('@sentry/react-native');

beforeEach(() => {
    jest.clearAllMocks();
    mockWidgetProps.current = null;
    mockSessionRef.current = { user: { id: 'u1', email: 'session@example.com' } };
    mockLocalRef.current = { userId: 'u1', userEmail: 'local@example.com' };
});

describe('FeedbackWidgetModal identity', () => {
    it('prefills the email and tags the Sentry user from the LOCAL store', () => {
        render(<FeedbackWidgetModal />);

        expect(mockWidgetProps.current.useSentryUser.email).toBe('local@example.com');
        expect(Sentry.setUser).toHaveBeenCalledWith({ id: 'u1' });
    });

    // The whole point: a session we could not fetch must not cost us the
    // reporter's identity.
    it('still identifies the reporter when the session cannot be fetched', () => {
        mockSessionRef.current = null;
        render(<FeedbackWidgetModal />);

        expect(mockWidgetProps.current.useSentryUser.email).toBe('local@example.com');
        expect(Sentry.setUser).toHaveBeenCalledWith({ id: 'u1' });
    });

    // Installs that signed in before the cached_user_email row existed have no
    // local email — the session stays as the fallback, so those users are no
    // worse off than before.
    it('falls back to the session for installs with no cached email', () => {
        mockLocalRef.current = { userId: null, userEmail: null };
        render(<FeedbackWidgetModal />);

        expect(mockWidgetProps.current.useSentryUser.email).toBe('session@example.com');
        expect(Sentry.setUser).toHaveBeenCalledWith({ id: 'u1' });
    });
});
