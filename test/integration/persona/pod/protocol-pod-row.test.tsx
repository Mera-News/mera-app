// The Mera Protocol list and the rows that change with a paired server: title and chevron only, the paired
// row in place of the control, and the fact-check answer following the mode.
import React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { fireEvent, render, renderHook, screen, act } from '@testing-library/react-native';
import MeraProtocolSettingsScreen from '@/components/custom/config-mera/MeraProtocolSettingsScreen';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useServerFactChecksOffered } from '@/lib/own-services/server-features';
import { ownAiState } from '@/lib/own-services/own-ai-state';
import { ownNewsState } from '@/lib/own-services/own-news-state';
import { forgetPairing, podState, savePairing } from '@/lib/own-services/pod-state';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { initI18nEn, podPairing } from '@/test/helpers';

jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return { __esModule: true, default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) => (visible ? <View>{children}</View> : null) };
});
jest.mock('react-native-reanimated', () => {
    const actual = jest.requireActual('react-native-reanimated/mock');
    return { ...actual, __esModule: true, default: actual.default ?? actual, useReducedMotion: () => true };
});
jest.mock('@/components/ui/gluestack-ui-provider', () => ({
    GluestackUIProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

const POD = '/logged-in/app_container/you/own-pod';
const mount = async () => {
    await render(<MeraProtocolSettingsScreen />);
    await screen.findByTestId('mera-protocol-notes');
};

beforeAll(initI18nEn);
beforeEach(() => {
    podState.resetMemory();
    ownAiState.resetMemory();
    ownNewsState.resetMemory();
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
    jest.mocked(router.push).mockClear();
    jest.mocked(useLocalSearchParams).mockReturnValue({});
});
afterEach(() => forgetPairing());

describe('Mera Protocol: your own Mera News server', () => {
    it('adds a third row in the group that opens the pod page, with title and chevron only', async () => {
        await mount();
        const row = screen.getByTestId('mera-protocol-own-pod');
        expect(row.props.accessibilityLabel).toBe('Your own Mera News server');
        await fireEvent.press(row);
        expect(router.push).toHaveBeenLastCalledWith(POD);
        for (const text of ['Server', 'Last synced', 'Read the news', 'Sync now']) expect(screen.queryByText(text)).toBeNull();
    });

    it('paired: the using row replaces the control, Verify is hidden, the row is title and chevron only', async () => {
        await savePairing(podPairing());
        await mount();
        expect(screen.queryByTestId('mera-protocol-mode')).toBeNull();
        expect(screen.queryByTestId('mera-protocol-attestation-toggle')).toBeNull();
        const using = await screen.findByText('Using your own Mera News server');
        for (const text of ['pod.own.test', 'Last synced', 'Read the news', 'Sync now']) expect(screen.queryByText(text)).toBeNull();
        await fireEvent.press(using);
        expect(router.push).toHaveBeenLastCalledWith(POD);
    });

    it('paired: the own AI and own news rows still open their pages', async () => {
        await savePairing(podPairing());
        await mount();
        await fireEvent.press(screen.getByText('Your own AI service'));
        expect(router.push).toHaveBeenLastCalledWith('/logged-in/app_container/you/own-ai');
        await fireEvent.press(screen.getByText('Your own news server'));
        expect(router.push).toHaveBeenLastCalledWith('/logged-in/app_container/you/own-news');
    });

    it('a ?focus=on-device link does nothing while paired', async () => {
        jest.mocked(useLocalSearchParams).mockReturnValue({ focus: 'on-device' });
        await savePairing(podPairing());
        await mount();
        expect(screen.queryByTestId('mera-protocol-on-device-tab')).toBeNull();
        expect(useMeraProtocolStore.getState().processingMode).toBe(ProcessingMode.Cloud);
    });
});

describe('server fact checks follow the paired mode', () => {
    it('are withdrawn the moment a pairing is stored, and offered again when it goes', async () => {
        const { result } = await renderHook(() => useServerFactChecksOffered());
        expect(result.current).toBe(true);
        await act(async () => savePairing(podPairing()));
        expect(result.current).toBe(false);
        await act(async () => forgetPairing());
        expect(result.current).toBe(true);
    });
});
