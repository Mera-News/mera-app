/* eslint-disable @typescript-eslint/no-require-imports */
// Tests for OnboardingWizard's step rendering after the mandatory-PIN removal
// (wizard is now 2 steps: 0 = Notifications, 1 = PersonaChat):
//   - step 1 renders the inline PersonaUpdateChatStep (not PersonaL1MeraProtocol)
//   - the floating ScreenChatBubble is no longer mounted anywhere in the wizard
import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

// The animated gradient backdrop is pure decoration and asserts nothing here,
// but it imports react-native-reanimated, whose worklets runtime cannot
// initialise under Jest. Stubbing the component keeps reanimated out of this
// suite's module graph entirely — cheaper and less fragile than mocking the
// whole animation library for a view that renders no testable content.
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({
    __esModule: true,
    default: () => null,
}));

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
// Stable action mocks (not re-created per render) so the resume tests below can
// assert what the mount effect did with the server stage.
const mockSetStep = jest.fn();
const mockUpdatePreferences = jest.fn();
const mockSetIsInitializing = jest.fn();
const mockResetOnboarding = jest.fn();
jest.mock('@/lib/stores/onboarding-store', () => ({
    useOnboardingStep: () => mockStep,
    useOnboardingPreferences: () => ({ userId: 'u1', notificationHours: [] as number[] }),
    useOnboardingIsInitializing: () => false,
    useOnboardingStore: () => ({
        setStep: mockSetStep,
        updatePreferences: mockUpdatePreferences,
        setIsInitializing: mockSetIsInitializing,
        resetOnboarding: mockResetOnboarding,
    }),
}));

import { AccountService } from '@/lib/account-service';
import { OnboardingStage } from '@/lib/generated/graphql-types';
import OnboardingWizard from '../OnboardingWizard';

beforeEach(() => {
    jest.clearAllMocks();
    mockStep = 0;
    (AccountService.getUserPersona as jest.Mock).mockResolvedValue(null);
});

describe('OnboardingWizard step rendering', () => {
    it('renders NotificationSettingsScreen on step 0 (not the persona chat)', async () => {
        mockStep = 0;
        const { queryByTestId } = render(<OnboardingWizard onComplete={jest.fn()} />);
        await waitFor(() => {
            expect(queryByTestId('notification-settings-screen')).toBeTruthy();
        });
        expect(queryByTestId('persona-update-chat-step')).toBeNull();
    });

    it('renders the inline PersonaUpdateChatStep on step 1', async () => {
        mockStep = 1;
        const { queryByTestId } = render(<OnboardingWizard onComplete={jest.fn()} />);
        await waitFor(() => {
            expect(queryByTestId('persona-update-chat-step')).toBeTruthy();
        });
        expect(queryByTestId('notification-settings-screen')).toBeNull();
    });

    it('never mounts the floating ScreenChatBubble (removed in r3)', async () => {
        mockStep = 1;
        const { queryByTestId } = render(<OnboardingWizard onComplete={jest.fn()} />);
        await waitFor(() => {
            expect(queryByTestId('persona-update-chat-step')).toBeTruthy();
        });
        // ScreenChatBubble is no longer imported or rendered by the wizard.
        expect(queryByTestId('screen-chat-bubble')).toBeNull();
    });
});

// The onboarding gate moved from the server's onboardingStage to the local fact
// count, so the wizard is now legitimately mounted for a user whose stage is
// already FINISHED (they tapped Next through the persona chat and captured
// nothing). The stage may only pick the RESUME step — it must never shortcut
// straight to completion.
describe('OnboardingWizard resume step from the server stage', () => {
    const renderAndSettle = async (onComplete = jest.fn()) => {
        const utils = render(<OnboardingWizard onComplete={onComplete} />);
        await waitFor(() => expect(mockSetStep).toHaveBeenCalled());
        return { ...utils, onComplete };
    };

    it('starts at step 1 (persona chat) when the server stage is FINISHED', async () => {
        (AccountService.getUserPersona as jest.Mock).mockResolvedValue({
            onboardingStage: OnboardingStage.Finished,
            preferredNotificationWindow: [],
        });
        const { onComplete } = await renderAndSettle();

        expect(mockSetStep).toHaveBeenCalledWith(1);
        // Critically: no auto-advance to completion off the server stage.
        expect(onComplete).not.toHaveBeenCalled();
        expect(mockResetOnboarding).not.toHaveBeenCalled();
    });

    it('starts at step 1 when the server stage is PERSONA_CHAT', async () => {
        (AccountService.getUserPersona as jest.Mock).mockResolvedValue({
            onboardingStage: OnboardingStage.PersonaChat,
            preferredNotificationWindow: [],
        });
        const { onComplete } = await renderAndSettle();

        expect(mockSetStep).toHaveBeenCalledWith(1);
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('starts at step 0 when the server stage is NOTIFICATIONS', async () => {
        (AccountService.getUserPersona as jest.Mock).mockResolvedValue({
            onboardingStage: OnboardingStage.Notifications,
            preferredNotificationWindow: [],
        });
        await renderAndSettle();

        expect(mockSetStep).toHaveBeenCalledWith(0);
    });

    it('starts at step 0 when there is no persona at all (first run)', async () => {
        (AccountService.getUserPersona as jest.Mock).mockResolvedValue(null);
        await renderAndSettle();

        expect(mockSetStep).toHaveBeenCalledWith(0);
    });
});
