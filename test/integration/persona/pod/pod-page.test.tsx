// The pages of "Your own Mera News server" at their seams: the real pairing and unpair code, the real stored
// state, the fake server over MSW, the app's dialog queue and the router. Nothing under the pages is replaced.
jest.mock('expo-keep-awake', () => ({
    activateKeepAwakeAsync: jest.fn(async () => undefined),
    deactivateKeepAwake: jest.fn(),
}));
jest.mock('expo-updates', () => ({ isEnabled: true, reloadAsync: jest.fn(async () => undefined) }));
jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return { __esModule: true, default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) => (visible ? <View>{children}</View> : null) };
});

import '@/lib/scheduler/tasks/feed-sync-task';

import React from 'react';
import { router, useFocusEffect } from 'expo-router';
import * as Updates from 'expo-updates';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import OwnAiServiceScreen from '@/components/custom/config-mera/own-services/OwnAiServiceScreen';
import OwnNewsServerScreen from '@/components/custom/config-mera/own-services/OwnNewsServerScreen';
import OwnPodScreen from '@/components/custom/config-mera/own-services/OwnPodScreen';
import PodCodeScreen from '@/components/custom/config-mera/own-services/PodCodeScreen';
import PodPairScreen from '@/components/custom/config-mera/own-services/PodPairScreen';
import { __resetAppRestartForTests } from '@/lib/app-restart';
import { _resetForTests as resetBreaker } from '@/lib/auth-failure-breaker';
import database from '@/lib/database';
import appSchema from '@/lib/database/schema';
import { getSetting } from '@/lib/database/services/setting-service';
import { settleDialog, useDialogQueue } from '@/lib/dialog';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { inferenceQueue, __setJobHandlerForTests } from '@/lib/inference/InferenceQueue';
import { ownAiState } from '@/lib/own-services/own-ai-state';
import { ownNewsState } from '@/lib/own-services/own-news-state';
import { resetPodHealth } from '@/lib/own-services/pod-health';
import { ALL_JOB_TYPES, enterPodMode, leavePodMode } from '@/lib/own-services/pod-runner';
import { forgetPairing, podPaired, podState, savePairing } from '@/lib/own-services/pod-state';
import { setReportSecrets } from '@/lib/own-services/report-secrets';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { resetToastQueue } from '@/lib/toast/toast-queue';
import { watermelonRowSink } from '@/lib/backup/adapters/watermelon-row-sink';
import { fakePod, initI18nEn, podPairing, podSnapshotFrom, POD_URL, resetDatabase, setAppState } from '@/test/helpers';
import { resetScheduler } from '@/test/integration/data/scheduler/core/support';
import { cleanupFeedSync, resetFeedSyncMemory } from '@/test/integration/data/feed-sync/steps/support';

jest.setTimeout(60_000);

const CODE = 'K7Q2M9XD';
const TOKEN = 'pod-token-abcdef123456';
const PAGE = '/logged-in/app_container/you';
const reload = Updates.reloadAsync as jest.Mock;
const COPY = {
    codeWrong: "This code didn't work.",
    expired: 'This code has expired. Run the pairing command again.',
    tooMany: 'Too many tries. Try again in a minute.',
    elsewhere: 'Your server is already paired with another device. Unpair that device first.',
    unreachableAddress: "Can't reach this address.",
    phoneOldCode: 'Update Mera News to pair with this server.',
    serverOld: 'Your server needs an update.',
    phoneOld: 'Update Mera News to keep syncing.',
    unreachable: "Can't reach your server. Showing what this phone has.",
    refused: 'Your server refused this phone. Pair again.',
};

let pod: ReturnType<typeof fakePod>;
const sent = (path: string) => pod.requests.filter((r) => r.path === path);
const dialog = () => useDialogQueue.getState().queue[0];
const answerDialog = async (yes: boolean) => act(async () => settleDialog(dialog().id, yes));
const flush = () => new Promise<void>((r) => setImmediate(r));
const until = async (cond: () => boolean, ms = 3000) => {
    for (const start = Date.now(); !cond(); await flush()) if (Date.now() - start > ms) throw new Error('timed out');
};
const factIds = async () => (await database.get('facts').query().fetch()).map((r) => r.id).sort();

beforeAll(async () => {
    await initI18nEn();
    jest.spyOn(console, 'info').mockImplementation(() => {});
});

beforeEach(async () => {
    resetScheduler();
    resetBreaker();
    resetFeedSyncMemory();
    resetPodHealth();
    resetToastQueue();
    __resetAppRestartForTests();
    reload.mockClear();
    podState.resetMemory();
    ownAiState.resetMemory();
    ownNewsState.resetMemory();
    useDialogQueue.setState({ queue: [] });
    useSchedulerStore.setState({ taskLastRun: {} });
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
    jest.mocked(router.push).mockClear();
    jest.mocked(router.navigate).mockClear();
    jest.mocked(router.replace).mockClear();
    setAppState('active');
    pod = fakePod({ token: TOKEN });
    await watermelonRowSink.createRows('facts', [{ id: 'phone-fact-1', statement: 'PHONE-FACT', created_at: 1, updated_at: 1 }]);
});

afterEach(async () => {
    await leavePodMode();
    await forgetPairing();
    resetToastQueue();
    await inferenceQueue.stop();
    for (const t of ALL_JOB_TYPES) __setJobHandlerForTests(t, undefined);
    AppScheduler.dispose();
    cleanupFeedSync();
    setReportSecrets('pod', null);
});

describe('the unpaired page', () => {
    const mount = async () => {
        await render(<OwnPodScreen />);
        await screen.findByTestId('own-pod-pair-button');
    };

    it('shows the intro with the Beta pill and both entries, and the entries open their pages', async () => {
        await mount();
        expect(screen.getByText('Your server reads and ranks the news. This phone shows the results.')).toBeTruthy();
        expect(screen.getByTestId('own-pod-beta')).toBeTruthy();
        expect(screen.getByText('Whoever runs your server decides how your data is used. Mera Labs still can\'t see your profile or your chats.')).toBeTruthy();
        expect(screen.getByTestId('own-pod-privacy')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('own-pod-pair-button'));
        expect(router.push).toHaveBeenLastCalledWith(`${PAGE}/own-pod-pair`);
        await fireEvent.press(screen.getByText('Enter code instead'));
        expect(router.push).toHaveBeenLastCalledWith(`${PAGE}/own-pod-code`);
    });

    it('lays the page out as approved: intro, Pair, the note, the policy link, then Enter code instead', async () => {
        await mount();
        const ids: string[] = [];
        const walk = (n: unknown): void => {
            if (!n || typeof n !== 'object') return;
            if (Array.isArray(n)) return n.forEach(walk);
            const node = n as { props?: { testID?: string }; children?: unknown };
            if (node.props?.testID) ids.push(node.props.testID);
            walk(node.children);
        };
        walk(screen.toJSON());
        const order = ['own-pod-beta', 'own-pod-pair-button', 'own-pod-note', 'own-pod-privacy', 'own-pod-enter-code'].map((id) => ids.indexOf(id));
        expect(order.every((i) => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('with On this phone on, Pair is dimmed with the line and the button', async () => {
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
        await mount();
        expect(screen.getByTestId('own-pod-pair-button')).toBeDisabled();
        expect(screen.getByText('Turn off On this phone first.')).toBeTruthy();
        await fireEvent.press(screen.getByText('Go to On this phone'));
        expect(router.navigate).toHaveBeenLastCalledWith(`${PAGE}/mera-protocol?focus=on-device`);
        jest.mocked(router.push).mockClear();
        await fireEvent.press(screen.getByTestId('own-pod-pair-button'));
        expect(router.push).not.toHaveBeenCalled();
    });

    it('the pair page gives the two steps as plain text', async () => {
        await render(<PodPairScreen />);
        expect(screen.getByText('On your server, run the pairing command.')).toBeTruthy();
        expect(screen.getByText('Scan its code with the Camera app, or open its link on this phone.')).toBeTruthy();
    });
});

describe('the code page', () => {
    const type = async (id: string, text: string) => fireEvent.changeText(screen.getByTestId(id), text);
    const fill = async (address = POD_URL, code = CODE) => {
        await type('own-pod-address', address);
        await type('own-pod-code', code);
    };
    const mount = async () => {
        await render(<PodCodeScreen />);
        await screen.findByTestId('own-pod-address');
    };
    /** Pair, then Erase and pair. */
    const pairThrough = async () => {
        await fireEvent.press(screen.getByTestId('own-pod-code-pair'));
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        await answerDialog(true);
    };

    it('Pair stays disabled until both fields are filled and the address parses', async () => {
        await mount();
        expect(screen.getByTestId('own-pod-code-pair')).toBeDisabled();
        await type('own-pod-address', POD_URL);
        expect(screen.getByTestId('own-pod-code-pair')).toBeDisabled();
        await type('own-pod-code', CODE);
        expect(screen.getByTestId('own-pod-code-pair')).toBeEnabled();
    });

    it('the code field takes upper case, no correction and the one-time-code hints', async () => {
        await mount();
        const f = screen.getByTestId('own-pod-code');
        expect(f.props).toMatchObject({ autoCapitalize: 'characters', autoCorrect: false, textContentType: 'oneTimeCode', autoComplete: 'one-time-code' });
    });

    it.each([
        ['http', 'http://pod.own.test', 'Use an address that starts with https://'],
        ['userinfo', 'https://me:pw@pod.own.test', 'Remove the name and password from this address.'],
        ['no scheme', 'pod.own.test', "This isn't a web address."],
    ])('an address with %s is refused on the page and nothing is sent', async (_n, address, line) => {
        await mount();
        await fill(address);
        expect(screen.getByText(line)).toBeTruthy();
        expect(screen.getByTestId('own-pod-code-pair')).toBeDisabled();
        await fireEvent.press(screen.getByTestId('own-pod-code-pair'));
        expect(useDialogQueue.getState().queue).toHaveLength(0);
        expect(pod.requests).toEqual([]);
    });

    it('shows the one confirm first: host only, the body, the red erase line, the backup line, a destructive button', async () => {
        await mount();
        await fill(`${POD_URL}/some/path`);
        await fireEvent.press(screen.getByTestId('own-pod-code-pair'));
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        const ask = dialog();
        expect(ask.title).toBe('Pair with pod.own.test?');
        expect(ask.body).toContain('Your server can see your profile, your chats and what you read. Pair only with a server you trust.');
        expect(ask.body).toContain('Backup stays off while this phone is paired.');
        expect(ask.body).not.toContain('Your own AI service and news server turn off');
        expect(ask.warning).toBe('Everything Mera News keeps on this phone is erased, and this phone then shows only what your server holds.');
        expect(ask.confirmLabel).toBe('Erase and pair');
        expect(ask.cancelLabel).toBe('Cancel');
        expect(ask.destructive).toBe(true);
        expect(JSON.stringify(ask)).not.toContain(CODE);
        // Nothing is sent before the press.
        expect(pod.requests).toEqual([]);
        await answerDialog(false);
    });

    it('names the port in the title only when it is not 443', async () => {
        await mount();
        await fill('https://pod.own.test:8443');
        await fireEvent.press(screen.getByTestId('own-pod-code-pair'));
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        expect(dialog().title).toBe('Pair with pod.own.test:8443?');
        await answerDialog(false);
        await fill('https://pod.own.test:443');
        await fireEvent.press(screen.getByTestId('own-pod-code-pair'));
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        expect(dialog().title).toBe('Pair with pod.own.test?');
        await answerDialog(false);
    });

    it('says so in the body while an own AI service or news server is on', async () => {
        await ownAiState.save({ v: 1, baseUrl: 'https://ai.own.test', model: 'm', key: null, on: true, checkedAt: 1, status: 'connected', confirmed: { at: 1, privacyVersion: null } });
        await mount();
        await fill();
        await fireEvent.press(screen.getByTestId('own-pod-code-pair'));
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        expect(dialog().body).toContain("Your own AI service and news server turn off. Your server's are used instead.");
        await answerDialog(false);
    });

    it('Cancel sends no /pair and leaves the phone untouched', async () => {
        await mount();
        await fill();
        await fireEvent.press(screen.getByTestId('own-pod-code-pair'));
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        await answerDialog(false);
        await flush();
        expect(pod.requests).toEqual([]);
        expect(podState.get()).toBeNull();
        expect(await factIds()).toEqual(['phone-fact-1']);
        expect(reload).not.toHaveBeenCalled();
    });

    it('Erase and pair erases, pairs, stores the confirmation and asks for the restart', async () => {
        // The server's copy holds only its own fact.
        await resetDatabase();
        pod.snapshot = await podSnapshotFrom(() => watermelonRowSink.createRows('facts', [{ id: 'server-fact-1', statement: 'SERVER', created_at: 1, updated_at: 1 }]));
        await watermelonRowSink.createRows('facts', [{ id: 'phone-fact-2', statement: 'PHONE-FACT', created_at: 1, updated_at: 1 }]);
        expect(await factIds()).toEqual(['phone-fact-2']);
        await mount();
        await fill();
        (global as { __DEV__?: boolean }).__DEV__ = false;
        try {
            await pairThrough();
            await until(() => reload.mock.calls.length > 0);
        } finally {
            (global as { __DEV__?: boolean }).__DEV__ = true;
        }
        expect(sent('/pair')).toHaveLength(1);
        expect(await factIds()).toEqual(['server-fact-1']);
        expect(podPaired()).toBe(true);
        expect(podState.get()?.confirmed).toEqual({ at: expect.any(Number), privacyVersion: null });
        expect(reload).toHaveBeenCalledTimes(1);
        expect(await getSetting('js_restart_marker')).toContain('pair');
    });

    it('a wrong code shows its line and stores nothing', async () => {
        await mount();
        await fill(POD_URL, 'WRONGCOD');
        await pairThrough();
        expect(await screen.findByText(COPY.codeWrong)).toBeTruthy();
        expect(podState.get()).toBeNull();
        expect(await factIds()).toEqual(['phone-fact-1']);
        expect(JSON.stringify(screen.toJSON())).not.toMatch(/pod request failed|wrong_code/);
    });

    it('an expired code, too many tries, and a server paired elsewhere each show their line and change nothing', async () => {
        await mount();
        await fill();
        pod.answer('/pair', 403, { error: 'pairing_closed' });
        await pairThrough();
        expect(await screen.findByText(COPY.expired)).toBeTruthy();
        pod.answer('/pair', 429, { error: 'too_many_tries' });
        await pairThrough();
        expect(await screen.findByText(COPY.tooMany)).toBeTruthy();
        pod.pairing.alreadyPaired = true;
        await pairThrough();
        expect(await screen.findByText(COPY.elsewhere)).toBeTruthy();
        expect(podState.get()).toBeNull();
        expect(await factIds()).toEqual(['phone-fact-1']);
    });

    it('an unreachable server shows the address line', async () => {
        pod.down();
        await mount();
        await fill();
        await pairThrough();
        expect(await screen.findByText(COPY.unreachableAddress)).toBeTruthy();
        expect(podState.get()).toBeNull();
    });

    it.each([
        ['a phone that is too old', 1, COPY.phoneOldCode],
        ['a server that is too old', -1, COPY.serverOld],
    ])('%s shows its line and the phone stays unpaired', async (_n, shift, line) => {
        await mount();
        await fill();
        pod.versions.schemaVersion = appSchema.version + shift;
        await pairThrough();
        expect(await screen.findByText(line)).toBeTruthy();
        expect(podState.get()).toBeNull();
        expect(await factIds()).toEqual(['phone-fact-1']);
    });
});

describe('the paired page', () => {
    const pair = async () => {
        await savePairing(podPairing({ token: TOKEN }));
        await enterPodMode();
    };
    const mount = async () => {
        await pair();
        // The page reads the server's status when it gains focus, as on a phone.
        jest.mocked(useFocusEffect).mockImplementation((cb) => React.useEffect(cb, [cb]));
        await render(<OwnPodScreen />);
        await screen.findByTestId('own-pod-server');
    };
    const sw = () => screen.getByTestId('own-pod-reading-switch');

    it('shows the server, hides Last synced before the first sync, and shows no status line', async () => {
        await mount();
        expect(screen.getByText('pod.own.test')).toBeTruthy();
        expect(screen.queryByText('Last synced')).toBeNull();
        expect(screen.queryByTestId('own-pod-status-line')).toBeNull();
        expect(screen.queryByText('Unpair this phone?')).toBeNull();
        await act(async () => useSchedulerStore.setState({ taskLastRun: { 'feed-sync': Date.now() } }));
        expect(screen.getByText('Last synced')).toBeTruthy();
    });

    it('Read the news follows the server and turning it off sends /reading', async () => {
        await mount();
        await waitFor(() => expect(sw().props.value).toBe(true));
        await fireEvent(sw(), 'valueChange', false);
        await waitFor(() => expect(sent('/reading')).toHaveLength(1));
        expect(sent('/reading')[0].body).toEqual({ paused: true });
        await waitFor(() => expect(sw().props.value).toBe(false));
        expect(pod.reading).toBe('paused');
    });

    it('while the server is pausing its reading, the switch shows on and is dimmed until the next status', async () => {
        pod.reading = 'pausing' as never;
        await mount();
        await waitFor(() => expect(sw()).toBeDisabled());
        expect(sw().props.value).toBe(true);
        pod.reading = 'paused';
        await fireEvent.press(screen.getByTestId('own-pod-sync'));
        await waitFor(() => expect(sw().props.value).toBe(false));
        expect(sw()).not.toBeDisabled();
    });

    it('a failed Read the news change puts the switch back and shows the unreachable line', async () => {
        await mount();
        await waitFor(() => expect(sw().props.value).toBe(true));
        pod.down();
        await fireEvent(sw(), 'valueChange', false);
        expect(await screen.findByText(COPY.unreachable)).toBeTruthy();
        expect(sw().props.value).toBe(true);
    });

    it('Sync now reaches /snapshot', async () => {
        await mount();
        const before = sent('/snapshot').length;
        await fireEvent.press(screen.getByTestId('own-pod-sync'));
        await waitFor(() => expect(sent('/snapshot').length).toBeGreaterThan(before));
    });

    it('the server down shows the unreachable line', async () => {
        await mount();
        pod.down();
        await fireEvent.press(screen.getByTestId('own-pod-sync'));
        expect(await screen.findByText(COPY.unreachable)).toBeTruthy();
        expect(screen.queryByText('Pair again')).toBeNull();
    });

    it('a refused token shows the line and Pair again, which leads to the unpaired page', async () => {
        await mount();
        pod.tokens.clear();
        await fireEvent.press(screen.getByTestId('own-pod-sync'));
        expect(await screen.findByText(COPY.refused)).toBeTruthy();
        await fireEvent.press(screen.getByTestId('own-pod-pair-again'));
        expect(await screen.findByTestId('own-pod-pair-button')).toBeTruthy();
        expect(podState.get()).toBeNull();
        expect(sent('/devices/revoke')).toHaveLength(0);
    });

    it('a version difference shows the matching update line', async () => {
        await mount();
        pod.versions.schemaVersion = appSchema.version + 1;
        await fireEvent.press(screen.getByTestId('own-pod-sync'));
        expect(await screen.findByText(COPY.phoneOld)).toBeTruthy();
    });

    it('a server that needs an update shows its line', async () => {
        await mount();
        pod.versions.schemaVersion = appSchema.version - 1;
        await fireEvent.press(screen.getByTestId('own-pod-sync'));
        expect(await screen.findByText(COPY.serverOld)).toBeTruthy();
    });

    it('Unpair asks first, Cancel changes nothing, and confirming leads to the unpaired page', async () => {
        await mount();
        await fireEvent.press(screen.getByTestId('own-pod-unpair'));
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        const ask = dialog();
        expect(ask.title).toBe('Unpair this phone?');
        expect(ask.body).toBe('This phone keeps its copy and stops using your server. Your server keeps its copy too.');
        expect(ask.confirmLabel).toBe('Unpair');
        expect(ask.destructive).toBe(true);
        await answerDialog(false);
        await flush();
        expect(podPaired()).toBe(true);
        expect(sent('/devices/revoke')).toHaveLength(0);

        await fireEvent.press(screen.getByTestId('own-pod-unpair'));
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        await answerDialog(true);
        expect(await screen.findByTestId('own-pod-pair-button')).toBeTruthy();
        expect(sent('/devices/revoke')).toHaveLength(1);
        expect(podState.get()).toBeNull();
    });

    it('every control has a role and a label, and the destructive row is a button', async () => {
        await mount();
        expect(sw().props.accessibilityLabel).toBe('Read the news');
        expect(screen.getByTestId('own-pod-sync').props.accessibilityRole).toBe('button');
        expect(screen.getByTestId('own-pod-unpair').props.accessibilityRole).toBe('button');
        expect(screen.getByLabelText('Unpair')).toBeTruthy();
    });
});

describe('the own AI and own news pages while paired', () => {
    it('dim the switch with "Unpair your server first." and no button', async () => {
        await savePairing(podPairing({ token: TOKEN }));
        await ownAiState.save({ v: 1, baseUrl: 'https://ai.own.test', model: 'm1', key: null, on: false, checkedAt: 1, status: 'connected', confirmed: null });
        await render(<OwnAiServiceScreen />);
        await screen.findByTestId('own-ai-address');
        expect(screen.getByTestId('own-ai-switch')).toBeDisabled();
        expect(screen.getByText('Unpair your server first.')).toBeTruthy();
        expect(screen.queryByText('Go to On this phone')).toBeNull();
        expect(screen.queryByText('See plans')).toBeNull();
    });

    it('does the same on the news page', async () => {
        await savePairing(podPairing({ token: TOKEN }));
        await ownNewsState.save({ v: 1, baseUrl: 'https://news.own.test', key: null, on: false, checkedAt: 1, status: 'connected', fields: ['articleIdsForPersona'], confirmed: null });
        await render(<OwnNewsServerScreen />);
        await screen.findByTestId('own-news-address');
        expect(screen.getByTestId('own-news-switch')).toBeDisabled();
        expect(screen.getByText('Unpair your server first.')).toBeTruthy();
    });
});
