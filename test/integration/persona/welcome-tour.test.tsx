/**
 * "Learn about Mera" on the welcome screen opens the interactive welcome tutorial (never a video), and the
 * tutorial's finish runs the one Get started path.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AuthScreen from '@/components/custom/auth/AuthScreen';
import { getChapter } from '@/lib/tutorials/chapters';
import { useThemeStore } from '@/lib/theme/theme-store';
import { initI18nEn } from '@/test/helpers';

jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return {
        __esModule: true,
        default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
            visible ? <View>{children}</View> : null,
    };
});

jest.mock('@/components/ui/gluestack-ui-provider', () => ({
    GluestackUIProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

beforeAll(initI18nEn);

// The auth hook is faked here (its own seam test is sign-in.test.ts); the real state is the tour flag.
const mockGo = jest.fn();
const mockGetStarted = jest.fn();
jest.mock('@/components/custom/auth/useAuthScreen', () => {
    const React = jest.requireActual('react');
    return {
        useAuthScreen: () => {
            const [tourOpen, setTourOpen] = React.useState(false);
            return {
                stage: 'welcome', forward: true, go: mockGo, cachedUserId: null, supportId: null,
                availability: 'available', signInPath: 'unavailable', pendingSwitch: null,
                tourOpen, setTourOpen, getStarted: mockGetStarted, starting: false,
                finishDeviceSignIn: jest.fn(), askSwitch: jest.fn(), handleSwitchContinue: jest.fn(),
                handleSwitchKeep: jest.fn(), leaveGate: jest.fn(),
            };
        },
    };
});
const mockPlayerProps = jest.fn();
jest.mock('@/components/custom/tutorials/TutorialPlayer', () => ({
    __esModule: true,
    default: (props: { chapterId: string; finishLabel?: string; onFinish?: () => void }) => {
        mockPlayerProps(props);
        const { Pressable, Text } = jest.requireActual('react-native');
        return <Pressable testID="fake-tour-finish" onPress={props.onFinish}><Text>{props.finishLabel}</Text></Pressable>;
    },
}));
jest.mock('@/components/custom/auth/WelcomeStage', () => ({
    __esModule: true,
    default: ({ onLearn }: { onLearn: () => void }) => {
        const { Pressable } = jest.requireActual('react-native');
        return <Pressable testID="auth-learn-mera" onPress={onLearn} />;
    },
}));
const mockVideoMounted = jest.fn();
jest.mock('@/components/custom/VideoPlayerModal', () => ({ __esModule: true, default: () => { mockVideoMounted(); return null; } }));
jest.mock('@/components/custom/auth/LaunchLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/bottom-sheet', () => ({
    BottomSheet: ({ open, children, testID }: { open: boolean; children?: React.ReactNode; testID?: string }) => {
        const { View } = jest.requireActual('react-native');
        return open ? <View testID={testID}>{children}</View> : null;
    },
}));

jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return {
        __esModule: true,
        default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
            visible ? <View>{children}</View> : null,
    };
});

jest.mock('@/components/ui/gluestack-ui-provider', () => ({
    GluestackUIProvider: ({ children }: { children?: React.ReactNode }) => children,
}));


describe('Learn about Mera opens the welcome tutorial', () => {
    beforeEach(() => jest.clearAllMocks());

    it('switches light and dark before sign-in, and says which mode it is on', async () => {
        useThemeStore.setState({ mode: 'dark' });
        await render(<AuthScreen />);
        const toggle = () => screen.getByTestId('auth-appearance');
        expect(toggle().props.accessibilityValue).toEqual({ text: 'Dark' });

        await fireEvent.press(toggle());
        await waitFor(() => expect(useThemeStore.getState().mode).toBe('light'));
        expect(toggle().props.accessibilityValue).toEqual({ text: 'Light' });
    });

    it('shows the tutorial sheet on the welcome chapter, and no video player', async () => {
        await render(<AuthScreen />);
        expect(screen.queryByTestId('tutorial-sheet')).toBeNull();
        await fireEvent.press(screen.getByTestId('auth-learn-mera'));
        expect(screen.getByTestId('tutorial-sheet')).toBeTruthy();
        expect(mockPlayerProps).toHaveBeenLastCalledWith(expect.objectContaining({ chapterId: 'welcome' }));
        expect(getChapter('welcome')).toBeDefined();
        expect(mockVideoMounted).not.toHaveBeenCalled();
    });

    it('its finish is labelled Get started and runs the one Get started path', async () => {
        await render(<AuthScreen />);
        await fireEvent.press(screen.getByTestId('auth-learn-mera'));
        expect(screen.getByText('Get started')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('fake-tour-finish'));
        expect(mockGetStarted).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('tutorial-sheet')).toBeNull();
    });
});
