/* eslint-disable @typescript-eslint/no-require-imports */
// Tests for OnboardingWizard's step rendering after the r3 rework:
//   - step 1 renders the inline PersonaUpdateChatStep (not PersonaL1MeraProtocol)
//   - the floating ScreenChatBubble is no longer mounted anywhere in the wizard
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

// css-interop JSX shim (reads Platform.OS at module load) — same as other tests.
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string, o?: any) => o?.defaultValue ?? k }),
}));

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-router', () => ({ router: { replace: jest.fn() } }));

// --- gluestack ui + icons → RN primitives ---------------------------------
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/progress', () => {
    const { View } = require('react-native');
    return { Progress: (p: any) => <View {...p} />, ProgressFilledTrack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return { Button: (p: any) => <Pressable {...p} />, ButtonText: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    const Passthrough = (p: any) => <View {...p} />;
    const Modal = ({ isOpen, children, ...rest }: any) => (isOpen ? <View {...rest}>{children}</View> : null);
    return { Modal, ModalBackdrop: Passthrough, ModalContent: Passthrough, ModalHeader: Passthrough, ModalBody: Passthrough, ModalFooter: Passthrough };
});
jest.mock('@/components/ui/toast', () => ({
    useToast: () => ({ show: jest.fn() }),
    Toast: (p: any) => { const { View } = require('react-native'); return <View {...p} />; },
    ToastTitle: (p: any) => { const { Text } = require('react-native'); return <Text {...p} />; },
    ToastDescription: (p: any) => { const { Text } = require('react-native'); return <Text {...p} />; },
}));

// --- step child components → light stubs (assert on testIDs) ---------------
jest.mock('@/components/custom/onboarding/PersonaUpdateChatStep', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View testID="persona-update-chat-step" {...p} /> };
});
jest.mock('@/components/custom/config-mera/NotificationSettingsScreen', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View testID="notification-settings-screen" {...p} /> };
});
jest.mock('@/components/custom/chat/OnboardingNavBar', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View testID="onboarding-nav-bar" {...p} /> };
});
// SetPinStep pulls in PinSetupScreen → MeraLogo (reanimated) at module load;
// stub it so the wizard's step-rendering can be asserted without native deps.
jest.mock('@/components/custom/onboarding/SetPinStep', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View testID="set-pin-step" {...p} /> };
});
jest.mock('@/lib/security/pin-service', () => ({ isPinSet: jest.fn(() => Promise.resolve(true)) }));

// --- services / stores ------------------------------------------------------
jest.mock('@/lib/account-service', () => ({
    AccountService: {
        // Return null → the init effect does not call setStep, so the test's
        // controlled `mockStep` stays authoritative for which step renders.
        getUserPersona: jest.fn(() => Promise.resolve(null)),
        updateNotificationPreferences: jest.fn(() => Promise.resolve()),
        advanceOnboardingStage: jest.fn(() => Promise.resolve()),
    },
}));
jest.mock('@/lib/auth-client', () => ({
    authClient: { getSession: jest.fn(() => Promise.resolve({ data: { user: { id: 'u1' } } })), signOut: jest.fn() },
    clearAuthStorage: jest.fn(),
}));
jest.mock('@/lib/notificationSlotUtils', () => ({
    convertLocalHoursToUTC: (h: number[]) => h,
    convertUTCHoursToLocal: (h: number[]) => h,
}));
jest.mock('@/lib/notification-service', () => ({ ensurePushTokenRegistered: jest.fn(() => Promise.resolve()) }));

const mockCollapse = jest.fn();
const mockSetSuppressed = jest.fn();
jest.mock('@/lib/stores/floating-chat-store', () => ({
    useFloatingChatStore: { getState: () => ({ collapse: mockCollapse, setSuppressed: mockSetSuppressed }) },
}));

let mockStep = 0;
jest.mock('@/lib/stores/onboarding-store', () => ({
    useOnboardingStep: () => mockStep,
    useOnboardingPreferences: () => ({ userId: 'u1', notificationHours: [] as number[] }),
    useOnboardingIsInitializing: () => false,
    useOnboardingStore: () => ({
        setStep: jest.fn(),
        updatePreferences: jest.fn(),
        setIsInitializing: jest.fn(),
        resetOnboarding: jest.fn(),
    }),
}));

import OnboardingWizard from '../OnboardingWizard';

beforeEach(() => {
    jest.clearAllMocks();
    mockStep = 0;
});

describe('OnboardingWizard step rendering', () => {
    it('renders the mandatory SetPinStep on step 0', async () => {
        mockStep = 0;
        const { queryByTestId } = render(<OnboardingWizard onComplete={jest.fn()} />);
        await waitFor(() => {
            expect(queryByTestId('set-pin-step')).toBeTruthy();
        });
        expect(queryByTestId('notification-settings-screen')).toBeNull();
        expect(queryByTestId('persona-update-chat-step')).toBeNull();
    });

    it('renders NotificationSettingsScreen on step 1 (not the persona chat)', async () => {
        mockStep = 1;
        const { queryByTestId } = render(<OnboardingWizard onComplete={jest.fn()} />);
        await waitFor(() => {
            expect(queryByTestId('notification-settings-screen')).toBeTruthy();
        });
        expect(queryByTestId('persona-update-chat-step')).toBeNull();
    });

    it('renders the inline PersonaUpdateChatStep on step 2', async () => {
        mockStep = 2;
        const { queryByTestId } = render(<OnboardingWizard onComplete={jest.fn()} />);
        await waitFor(() => {
            expect(queryByTestId('persona-update-chat-step')).toBeTruthy();
        });
        expect(queryByTestId('notification-settings-screen')).toBeNull();
    });

    it('never mounts the floating ScreenChatBubble (removed in r3)', async () => {
        mockStep = 2;
        const { queryByTestId } = render(<OnboardingWizard onComplete={jest.fn()} />);
        await waitFor(() => {
            expect(queryByTestId('persona-update-chat-step')).toBeTruthy();
        });
        // ScreenChatBubble is no longer imported or rendered by the wizard.
        expect(queryByTestId('screen-chat-bubble')).toBeNull();
    });
});
