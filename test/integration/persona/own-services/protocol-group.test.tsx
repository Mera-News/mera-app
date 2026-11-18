// The Mera Protocol page's own-services group, and what own modes do to the rest of the page.
// The page runs on its real hook; the stored state is the real state; the router is the setup's.
import React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { fireEvent, render, screen } from '@testing-library/react-native';
import MeraProtocolSettingsScreen from '@/components/custom/config-mera/MeraProtocolSettingsScreen';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { ownAiState } from '@/lib/own-services/own-ai-state';
import { ownNewsState } from '@/lib/own-services/own-news-state';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { initI18nEn } from '@/test/helpers';

// The RN Modal native spec cannot load under Jest, and the shared Reanimated mock has no useReducedMotion.
jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return { __esModule: true, default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) => (visible ? <View>{children}</View> : null) };
});
jest.mock('react-native-reanimated', () => {
    const actual = jest.requireActual('react-native-reanimated/mock');
    return { ...actual, __esModule: true, default: actual.default ?? actual, useReducedMotion: () => true };
});

// The provider's colour-scheme call is a native edge; the page's own look is not under test here.
jest.mock('@/components/ui/gluestack-ui-provider', () => ({
    GluestackUIProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

const aiOn = () => ownAiState.save({ v: 1, baseUrl: 'https://ai.own.test', model: 'm', key: null, on: true, checkedAt: 1, status: 'connected' });
const newsOn = () =>
    ownNewsState.save({ v: 1, baseUrl: 'https://news.own.test', key: null, on: true, checkedAt: 1, status: 'connected', fields: null });

const mount = async () => {
    await render(<MeraProtocolSettingsScreen />);
    await screen.findByTestId('mera-protocol-notes');
};

beforeAll(initI18nEn);
beforeEach(() => {
    ownAiState.resetMemory();
    ownNewsState.resetMemory();
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
    jest.mocked(router.push).mockClear();
    jest.mocked(useLocalSearchParams).mockReturnValue({});
});

describe('Mera Protocol: your own services', () => {
    it('shows the group with its two rows and its footer, and the rows open their pages', async () => {
        await mount();
        expect(screen.getByText('For people who run their own AI or news server. Most people don\'t need this.')).toBeTruthy();
        await fireEvent.press(screen.getByText('Your own AI service'));
        expect(router.push).toHaveBeenLastCalledWith('/logged-in/app_container/you/own-ai');
        await fireEvent.press(screen.getByText('Your own news server'));
        expect(router.push).toHaveBeenLastCalledWith('/logged-in/app_container/you/own-news');
        expect(screen.getByTestId('mera-protocol-mode')).toBeTruthy();
        expect(screen.queryByText('Using your own AI service')).toBeNull();
    });

    it('with On this phone on, the footer is replaced', async () => {
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
        await mount();
        expect(screen.getByText('Turn off On this phone to use these.')).toBeTruthy();
        expect(screen.queryByText(/Most people don't need this/)).toBeNull();
    });

    it('own AI on: the control is gone and a row opens the AI page; Verify is hidden', async () => {
        await aiOn();
        await mount();
        expect(screen.queryByTestId('mera-protocol-mode')).toBeNull();
        expect(screen.queryByTestId('mera-protocol-attestation-toggle')).toBeNull();
        await fireEvent.press(await screen.findByText('Using your own AI service'));
        expect(router.push).toHaveBeenLastCalledWith('/logged-in/app_container/you/own-ai');
    });

    it('own news on: the control stays and a row under it opens the news page; Verify stays', async () => {
        await newsOn();
        await mount();
        expect(screen.getByTestId('mera-protocol-mode')).toBeTruthy();
        expect(screen.getByTestId('mera-protocol-attestation-toggle')).toBeTruthy();
        await fireEvent.press(await screen.findByText('Using your own news server'));
        expect(router.push).toHaveBeenLastCalledWith('/logged-in/app_container/you/own-news');
    });

    it('both on: one row, no control', async () => {
        await aiOn();
        await newsOn();
        await mount();
        expect(screen.getByText('Using your own services')).toBeTruthy();
        expect(screen.queryByTestId('mera-protocol-mode')).toBeNull();
        expect(screen.queryByText('Using your own AI service')).toBeNull();
        expect(screen.queryByText('Using your own news server')).toBeNull();
    });

    it('a ?focus=on-device link never puts the phone on device under an own mode', async () => {
        jest.mocked(useLocalSearchParams).mockReturnValue({ focus: 'on-device' });
        await newsOn();
        await mount();
        expect(screen.queryByTestId('mera-protocol-on-device-tab')).toBeNull();
    });

    it('a ?focus=on-device link still opens the On this phone tab with no own mode', async () => {
        jest.mocked(useLocalSearchParams).mockReturnValue({ focus: 'on-device' });
        await mount();
        expect(await screen.findByTestId('mera-protocol-on-device-tab')).toBeTruthy();
    });
});
