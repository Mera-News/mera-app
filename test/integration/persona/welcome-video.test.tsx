/**
 * The welcome screen's Get started and "Learn about Mera", the Settings system check, and the full-screen player closes itself when the video reaches its end.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import WelcomeStage from '@/components/custom/auth/WelcomeStage';
import SystemCheckStage from '@/components/custom/system-check/SystemCheckStage';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import VideoPlayerModal from '@/components/custom/VideoPlayerModal';
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

const mockListeners: Record<string, (() => void)[]> = {};
const mockPlayer = {
    status: 'readyToPlay',
    loop: true,
    play: jest.fn(),
    addListener: (name: string, cb: () => void) => {
        (mockListeners[name] ??= []).push(cb);
        return { remove: () => { mockListeners[name] = (mockListeners[name] ?? []).filter((c) => c !== cb); } };
    },
};
jest.mock('expo-video', () => ({
    useVideoPlayer: (_src: unknown, setup?: (p: typeof mockPlayer) => void) => {
        setup?.(mockPlayer);
        return mockPlayer;
    },
    VideoView: () => null,
}));

// The check rows' animated mark drives a Reanimated sweep the Jest mock cannot run.
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));

beforeAll(initI18nEn);

const welcome = (over: Partial<React.ComponentProps<typeof WelcomeStage>> = {}) =>
    render(<WelcomeStage messageTop={0} canUsePhone onGetStarted={jest.fn()} onLearn={jest.fn()} {...over} />);

describe('Welcome screen actions', () => {
    it('shows Get started and Learn about Mera, and no Begin Mera', async () => {
        await welcome();
        expect(screen.getByTestId('auth-begin-without-email')).toBeTruthy();
        expect(screen.getByTestId('auth-learn-mera')).toBeTruthy();
        expect(screen.queryByTestId('auth-begin-mera')).toBeNull();
    });

    it('Learn about Mera calls its handler', async () => {
        const onLearn = jest.fn();
        await welcome({ onLearn });
        await fireEvent.press(screen.getByTestId('auth-learn-mera'));
        expect(onLearn).toHaveBeenCalledTimes(1);
    });

    it('Get started saves the language, then moves on', async () => {
        const setAppLanguage = jest.spyOn(useAppLanguageStore.getState(), 'setAppLanguage').mockResolvedValue(undefined as never);
        const onGetStarted = jest.fn();
        await welcome({ onGetStarted });
        await fireEvent.press(screen.getByTestId('auth-begin-without-email'));
        expect(setAppLanguage).toHaveBeenCalledTimes(1);
        expect(onGetStarted).toHaveBeenCalledTimes(1);
        setAppLanguage.mockRestore();
    });

    it('an unsupported phone shows the notice and no buttons', async () => {
        await welcome({ canUsePhone: false });
        expect(screen.getByTestId('auth-begin-unsupported')).toBeTruthy();
        expect(screen.queryByTestId('auth-begin-without-email')).toBeNull();
        expect(screen.queryByTestId('auth-learn-mera')).toBeNull();
    });
});

describe('Settings system check', () => {
    it('is unchanged: title, all four rows, Continue', async () => {
        jest.useFakeTimers();
        const onContinue = jest.fn();
        await render(<SystemCheckStage onContinue={onContinue} testID="settings-system-check" />);
        expect(screen.getByText('Checking your phone')).toBeTruthy();
        for (let i = 0; i < 4; i += 1) await act(async () => { await jest.advanceTimersByTimeAsync(150); });
        expect(screen.getByTestId('settings-system-check-ai')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('settings-system-check-continue'));
        await act(async () => { await jest.advanceTimersByTimeAsync(0); });
        expect(onContinue).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
    });
});

describe('VideoPlayerModal', () => {
    it('closes itself when playback reaches the end, when asked to', async () => {
        const onClose = jest.fn();
        await render(<VideoPlayerModal visible uri="https://example.test/welcome-en.mp4" onClose={onClose} closeOnEnd />);
        expect(onClose).not.toHaveBeenCalled();
        mockListeners.playToEnd.forEach((cb) => cb());
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('stays open at the end by default (the guide videos)', async () => {
        const onClose = jest.fn();
        await render(<VideoPlayerModal visible uri="https://example.test/guide.mp4" onClose={onClose} />);
        (mockListeners.playToEnd ?? []).forEach((cb) => cb());
        expect(onClose).not.toHaveBeenCalled();
    });
});
