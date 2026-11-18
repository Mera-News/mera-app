// The pairing link: its landing route, what it holds, and the pod page that offers the confirm.
// The link never pairs by itself: the confirm is the only way.
jest.mock('expo-keep-awake', () => ({
    activateKeepAwakeAsync: jest.fn(async () => undefined),
    deactivateKeepAwake: jest.fn(),
}));
jest.mock('expo-updates', () => ({ isEnabled: true, reloadAsync: jest.fn(async () => undefined) }));
jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return { __esModule: true, default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) => (visible ? <View>{children}</View> : null) };
});

import React from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import OwnPodScreen from '@/components/custom/config-mera/own-services/OwnPodScreen';
import PodPairRoute from '@/app/pod-pair';
import { _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import { setSetting } from '@/lib/database/services/setting-service';
import { settleDialog, useDialogQueue } from '@/lib/dialog';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { ownAiState } from '@/lib/own-services/own-ai-state';
import { takePendingPairLink } from '@/lib/own-services/pending-pair-link';
import { forgetPairing, podState, savePairing } from '@/lib/own-services/pod-state';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { usePinStore } from '@/lib/stores/pin-store';
import { resetToastQueue, useToastQueue } from '@/lib/toast/toast-queue';
import { fakePod, initI18nEn, podPairing, POD_URL, resetDatabase } from '@/test/helpers';

jest.setTimeout(60_000);

const CODE = 'K7Q2M9XD';
const POD_ROUTE = '/logged-in/app_container/you/own-pod';
let pod: ReturnType<typeof fakePod>;
const dialog = () => useDialogQueue.getState().queue[0];
const answer = async (yes: boolean) => act(async () => settleDialog(dialog().id, yes));
const link = (params: Record<string, string>) => jest.mocked(useLocalSearchParams).mockReturnValue(params);
const goodLink = (u = POD_URL, c = CODE) => link({ u, c });
const signedInAndSetUp = async () => {
    await setSetting('cached_user_id', 'user-1');
    await setSetting('onboarding_done', 'true');
};
const openRoute = async () => {
    await render(<PodPairRoute />);
};
/** The pod page, with focus effects running as they do on a focused screen. */
const openPodPage = async () => {
    jest.mocked(useFocusEffect).mockImplementation((cb) => React.useEffect(cb, [cb]));
    await render(<OwnPodScreen />);
    await screen.findByTestId('own-pod-pair-button');
};

beforeAll(initI18nEn);
beforeEach(async () => {
    resetBreaker();
    resetToastQueue();
    podState.resetMemory();
    ownAiState.resetMemory();
    takePendingPairLink();
    useDialogQueue.setState({ queue: [] });
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
    usePinStore.setState({ locked: false });
    jest.mocked(router.replace).mockClear();
    jest.mocked(router.navigate).mockClear();
    pod = fakePod({ token: 'pod-token-abcdef123456' });
});
afterEach(async () => {
    jest.mocked(useFocusEffect).mockReset();
    await forgetPairing();
    await resetDatabase();
});

describe('the pairing link', () => {
    it('valid while unlocked: opens the pod page, the confirm appears, and nothing pairs before Pair', async () => {
        await signedInAndSetUp();
        goodLink();
        await openRoute();
        await waitFor(() => expect(router.replace).toHaveBeenCalledWith(POD_ROUTE));
        await openPodPage();
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        expect(dialog().title).toBe('Pair with pod.own.test?');
        expect(dialog().destructive).toBe(true);
        expect(JSON.stringify(dialog())).not.toContain(CODE);
        expect(pod.requests).toEqual([]);
        expect(podState.get()).toBeNull();
        await answer(false);
        expect(pod.requests).toEqual([]);
        // Held once: a second visit offers nothing.
        expect(takePendingPairLink()).toBeNull();
    });

    it('pairs only after Erase and pair, with the link\'s address and code', async () => {
        await signedInAndSetUp();
        goodLink();
        await openRoute();
        await openPodPage();
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        await answer(true);
        await waitFor(() => expect(pod.requests.some((r) => r.path === '/pair')).toBe(true));
        expect(pod.requests.find((r) => r.path === '/pair')?.body.code).toBe(CODE);
    });

    it('a locked PIN shows no dialog until the unlock, then the confirm', async () => {
        await signedInAndSetUp();
        usePinStore.setState({ locked: true });
        goodLink();
        await openRoute();
        await openPodPage();
        await new Promise((r) => setTimeout(r, 50));
        expect(useDialogQueue.getState().queue).toHaveLength(0);
        await act(async () => usePinStore.getState().unlock());
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        expect(dialog().title).toBe('Pair with pod.own.test?');
        expect(pod.requests).toEqual([]);
        await answer(false);
    });

    it('before onboarding it says to finish setting up, and nothing is held', async () => {
        await setSetting('cached_user_id', 'user-1');
        goodLink();
        await openRoute();
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        expect(dialog().title).toBe('Your own Mera News server');
        expect(dialog().body).toBe('Finish setting up Mera News, then open the link again.');
        expect(takePendingPairLink()).toBeNull();
        await answer(true);
        await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
    });

    it('signed out says the same and holds nothing', async () => {
        await setSetting('onboarding_done', 'true');
        goodLink();
        await openRoute();
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        expect(dialog().body).toBe('Finish setting up Mera News, then open the link again.');
        expect(takePendingPairLink()).toBeNull();
        await answer(true);
    });

    it.each([
        ['userinfo', { u: 'https://me:pw@pod.own.test', c: CODE }],
        ['http', { u: 'http://pod.own.test', c: CODE }],
        ['no code', { u: POD_URL }],
        ['nothing', {}],
    ])('a link with %s shows the plain error line and holds nothing', async (_n, params) => {
        await signedInAndSetUp();
        link(params as Record<string, string>);
        await openRoute();
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        expect(dialog().body).toBe("This pairing link isn't valid.");
        expect(takePendingPairLink()).toBeNull();
        expect(router.replace).not.toHaveBeenCalledWith(POD_ROUTE);
        await answer(true);
    });

    it('while already paired it names the host and holds nothing', async () => {
        await signedInAndSetUp();
        await savePairing(podPairing());
        goodLink();
        await openRoute();
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        expect(dialog().body).toBe('This phone is already paired with pod.own.test. Unpair it first.');
        expect(takePendingPairLink()).toBeNull();
        await answer(true);
    });

    it('with On this phone on it offers the way to turn it off, and holds nothing', async () => {
        await signedInAndSetUp();
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
        goodLink();
        await openRoute();
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        expect(dialog().body).toBe('Turn off On this phone first.');
        expect(dialog().confirmLabel).toBe('Go to On this phone');
        expect(dialog().cancelLabel).toBe('Cancel');
        expect(takePendingPairLink()).toBeNull();
        await answer(true);
        await waitFor(() => expect(router.navigate).toHaveBeenCalledWith('/logged-in/app_container/you/mera-protocol?focus=on-device'));
    });

    it('opened cold, before the mode setting was read, it still sees On this phone and holds nothing', async () => {
        await signedInAndSetUp();
        // The phone runs On this phone, but the store has not read the setting yet.
        await setSetting('mera_processing_mode', ProcessingMode.OnDevice);
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
        goodLink();
        await openRoute();
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        expect(dialog().body).toBe('Turn off On this phone first.');
        expect(takePendingPairLink()).toBeNull();
        await answer(false);
    });

    it('an xn-- host appears in the title as written', async () => {
        await signedInAndSetUp();
        goodLink('https://xn--bcher-kva.example');
        await openRoute();
        await openPodPage();
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        expect(dialog().title).toBe('Pair with xn--bcher-kva.example?');
        await answer(false);
    });

    it('an unreachable server after the confirm shows the toast and changes nothing', async () => {
        await signedInAndSetUp();
        pod.down();
        goodLink();
        await openRoute();
        await openPodPage();
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        await answer(true);
        await waitFor(() => expect(useToastQueue.getState().entries).toHaveLength(1));
        const toast = useToastQueue.getState().entries[0].render({ id: useToastQueue.getState().entries[0].id }) as { props: { title?: string } };
        expect(toast.props.title).toBe("Can't reach your server. Nothing was changed.");
        expect(podState.get()).toBeNull();
    });
});
