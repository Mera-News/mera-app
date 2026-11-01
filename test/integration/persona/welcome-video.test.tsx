/**
 * The first-launch "Learn about Mera" video: the button lives on the Begin screen (not the welcome
 * screen), and the full-screen player closes itself when the video reaches its end.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { BeginStage } from '@/components/custom/auth/stages/BeginStage';
import WelcomeStage from '@/components/custom/auth/WelcomeStage';
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

beforeAll(initI18nEn);

describe('Learn about Mera', () => {
    it('is on the Begin screen and calls its handler', async () => {
        const onLearn = jest.fn();
        await render(<BeginStage canUsePhone onWithoutEmail={jest.fn()} onLearn={onLearn} onLogoSlot={jest.fn()} />);
        await fireEvent.press(screen.getByTestId('auth-learn-mera'));
        expect(onLearn).toHaveBeenCalledTimes(1);
    });

    it('is hidden when the phone cannot be used', async () => {
        await render(<BeginStage canUsePhone={false} onWithoutEmail={jest.fn()} onLearn={jest.fn()} onLogoSlot={jest.fn()} />);
        expect(screen.queryByTestId('auth-learn-mera')).toBeNull();
    });

    it('is gone from the welcome screen', async () => {
        await render(<WelcomeStage messageTop={0} onBegin={jest.fn()} />);
        expect(screen.queryByTestId('auth-learn-mera')).toBeNull();
        expect(screen.getByTestId('auth-begin-mera')).toBeTruthy();
    });
});

describe('VideoPlayerModal', () => {
    it('closes itself when playback reaches the end', async () => {
        const onClose = jest.fn();
        await render(<VideoPlayerModal visible uri="https://example.test/welcome-en.mp4" onClose={onClose} />);
        expect(onClose).not.toHaveBeenCalled();
        mockListeners.playToEnd.forEach((cb) => cb());
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
