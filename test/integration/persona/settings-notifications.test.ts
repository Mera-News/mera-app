// You > Settings > Notifications through `useNotificationSettings`: loading the window and the on/off flag,
// the debounced auto-save of the hours, and turning notifications on and off. Real hook, notification
// service, stores, Apollo over MSW, auth client, in-memory DB and real toast queue. Mocked: expo-notifications
// (the permission prompt and status, an edge) from the setup, driven per test.
import * as Notifications from 'expo-notifications';
import { act, configure, renderHook, waitFor } from '@testing-library/react-native';
import { useNotificationSettings } from '@/components/custom/config-mera/useNotificationSettings';
import database from '@/lib/database';
import { useUserStore } from '@/lib/stores/user-store';
import { resetToastQueue, toastApi, useToastQueue } from '@/lib/toast/toast-queue';
import {
    FIXTURE_ACCOUNT,
    graphql,
    HttpResponse,
    initI18nEn,
    mockGql,
    mockGqlError,
    server,
    setAppState,
    signInFixtureAccount,
    useFakeClock,
} from '@/test/helpers';
import { personaFor } from '@/test/mock-backend/fixtures/graphql/persona';

// MSW answers on real I/O while the fake clock ticks, so the default one-second wait is too tight.
configure({ asyncUtilTimeout: 20_000 });

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const AUTO_SAVE_DELAY_MS = 800;

const permissions = Notifications.getPermissionsAsync as unknown as jest.Mock;
const requestPermissions = Notifications.requestPermissionsAsync as unknown as jest.Mock;

// Local <-> UTC hour, the zone-independent way: through a Date.
const toUtc = (local: number) => {
    const d = new Date();
    d.setHours(local, 0, 0, 0);
    return d.getUTCHours();
};
const toLocal = (utc: number) => {
    const d = new Date();
    d.setUTCHours(utc, 0, 0, 0);
    return d.getHours();
};

/** The server persona: its enabled flag and UTC window. */
const serverPersona = (over: { notificationsEnabled?: boolean; window?: number[] }) =>
    server.use(
        mockGql('GetUserPersona', (v: Record<string, unknown>) => ({
            userPersonaByUserId: personaFor(Date.now(), {
                userId: (v.userId as string) ?? FIXTURE_ACCOUNT.userId,
                notificationsEnabled: over.notificationsEnabled ?? false,
                preferredNotificationWindow: over.window ?? [8, 20],
            }),
        })),
    );

/** Inputs of a mutation the server received, in order. */
function recordMutation(name: string, field: string): Record<string, unknown>[] {
    const sent: Record<string, unknown>[] = [];
    server.use(
        graphql.mutation(name, ({ variables }) => {
            const input = (variables as { input: Record<string, unknown> }).input;
            sent.push(input);
            return HttpResponse.json({
                data: { [field]: personaFor(Date.now(), { userId: input.userId as string, notificationsEnabled: input.enabled as boolean }) },
            });
        }),
    );
    return sent;
}

const toastTitles = () =>
    useToastQueue.getState().entries.map((e) => {
        const first = (e.render({ id: e.id }) as { props: { children: { props: { children: unknown } }[] } }).props.children[0];
        return String(first.props.children);
    });

type Options = Partial<Parameters<typeof useNotificationSettings>[0]>;
async function mount(options: Options = {}) {
    const props = { isOnboarding: false, initialHours: [] as number[], toast: toastApi, ...options };
    const hook = renderHook((p: Options) => useNotificationSettings({ ...props, ...p }), { initialProps: {} as Options });
    if (!props.isOnboarding) await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
    return hook;
}

/**
 * Lets background work land before the test ends. Settings writes are fired without awaiting, and a write
 * started under the fake clock needs the fake clock to finish: if the clock is restored first, the write never
 * completes and the next test's DB reset waits on it forever. This must run BEFORE the setup's own afterEach
 * (which restores real timers), which is why every test sits inside a describe: a nested afterEach runs first.
 */
async function settleBackgroundWork() {
    if ('clock' in (setTimeout as unknown as object)) await jest.advanceTimersByTimeAsync(200);
    else await new Promise((r) => setTimeout(r, 25));
    await database.write(async () => {});
}

describe('notification settings', () => {
    beforeAll(async () => {
        await initI18nEn();
    });

    beforeEach(async () => {
        resetToastQueue();
        useUserStore.setState({ userPersona: null });
        permissions.mockReset().mockResolvedValue({ status: 'granted' });
        requestPermissions.mockReset().mockResolvedValue({ status: 'granted' });
        await signInFixtureAccount();
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await settleBackgroundWork();
    });

    // ---------------------------------------------------------------------------------------------
    describe('loading', () => {
        it('reads the persona window (UTC -> local, sorted) and the enabled flag', async () => {
            serverPersona({ notificationsEnabled: true, window: [20, 8, 14] });
            const { result } = await mount();

            expect(result.current.notificationsEnabled).toBe(true);
            expect(result.current.selectedHours).toEqual([8, 14, 20].map(toLocal).sort((a, b) => a - b));
            expect(result.current.osRefused).toBe(false);
        });

        it('a persona with no window keeps the hours it was given', async () => {
            serverPersona({ window: [] });
            const { result } = await mount({ initialHours: [9] });
            expect(result.current.selectedHours).toEqual([9]);
        });

        it('off + the phone has refused notifications: osRefused', async () => {
            serverPersona({ notificationsEnabled: false });
            permissions.mockResolvedValue({ status: 'denied' });

            const { result } = await mount();

            expect(result.current.notificationsEnabled).toBe(false);
            await waitFor(() => expect(result.current.osRefused).toBe(true));
        });

        it('off + not asked yet is not "refused"', async () => {
            serverPersona({ notificationsEnabled: false });
            permissions.mockResolvedValue({ status: 'undetermined' });
            const { result } = await mount();
            await new Promise((r) => setTimeout(r, 30));
            expect(result.current.osRefused).toBe(false);
        });

        it('a failing persona read shows "Load Failed" and still ends loading', async () => {
            server.use(mockGqlError('GetUserPersona', 'INTERNAL_SERVER_ERROR'));
            const { result } = await mount();
            expect(result.current.isLoading).toBe(false);
            expect(toastTitles()).toEqual(['Load Failed']);
        });

        it('onboarding mode reads only the enabled flag and is never "loading"', async () => {
            serverPersona({ notificationsEnabled: true, window: [3] });
            const onEnabledChange = jest.fn();
            const { result } = await mount({ isOnboarding: true, initialHours: [9], onEnabledChange });

            expect(result.current.isLoading).toBe(false);
            await waitFor(() => expect(result.current.notificationsEnabled).toBe(true));
            expect(result.current.selectedHours).toEqual([9]);
            // Reported once the first read has landed, and again on each settled change.
            await waitFor(() => expect(onEnabledChange).toHaveBeenLastCalledWith(true));
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('saving the hours', () => {
        beforeEach(() => {
            serverPersona({ notificationsEnabled: true });
        });

        function recordWindows(): Record<string, unknown>[] {
            const sent: Record<string, unknown>[] = [];
            server.use(
                graphql.mutation('UpdateNotificationWindow', ({ variables }) => {
                    const input = (variables as { input: Record<string, unknown> }).input;
                    sent.push(input);
                    return HttpResponse.json({
                        data: { updateNotificationWindow: personaFor(Date.now(), { preferredNotificationWindow: input.preferredNotificationWindow as number[] }) },
                    });
                }),
            );
            return sent;
        }

        it('saves unique hours 0-23 (as UTC) once the selection has been quiet for the delay', async () => {
            const sent = recordWindows();
            const { result } = await mount();
            useFakeClock(NOW);

            act(() => result.current.handleHoursChange([6, 9, 18]));
            expect(result.current.saveState).toBe('idle');
            await act(async () => {
                await jest.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS - 100);
            });
            expect(sent).toEqual([]);

            await act(async () => {
                await jest.advanceTimersByTimeAsync(300);
            });
            await waitFor(() => expect(result.current.saveState).toBe('saved'));

            expect(sent).toHaveLength(1);
            expect(sent[0].userId).toBe(FIXTURE_ACCOUNT.userId);
            const window = sent[0].preferredNotificationWindow as number[];
            expect(window).toEqual([6, 9, 18].map(toUtc));
            expect(new Set(window).size).toBe(window.length);
            window.forEach((h) => {
                expect(Number.isInteger(h)).toBe(true);
                expect(h).toBeGreaterThanOrEqual(0);
                expect(h).toBeLessThanOrEqual(23);
            });
        });

        it('two changes inside the delay send only the latest', async () => {
            const sent = recordWindows();
            const { result } = await mount();
            useFakeClock(NOW);

            act(() => result.current.handleHoursChange([6]));
            await act(async () => {
                await jest.advanceTimersByTimeAsync(400);
            });
            act(() => result.current.handleHoursChange([6, 7]));
            await act(async () => {
                await jest.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS + 200);
            });

            await waitFor(() => expect(sent).toHaveLength(1));
            expect(sent[0].preferredNotificationWindow).toEqual([6, 7].map(toUtc));
        });

        it('an empty selection is never sent', async () => {
            const sent = recordWindows();
            const { result } = await mount();
            useFakeClock(NOW);

            act(() => result.current.handleHoursChange([6]));
            act(() => result.current.handleHoursChange([]));
            await act(async () => {
                await jest.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS * 3);
            });

            expect(sent).toEqual([]);
            expect(result.current.saveState).toBe('idle');
        });

        it('a change still pending when the screen closes is saved on the way out', async () => {
            const sent = recordWindows();
            const { result, unmount } = await mount();
            useFakeClock(NOW);

            act(() => result.current.handleHoursChange([10, 11]));
            unmount();

            await waitFor(() => expect(sent).toHaveLength(1));
            expect(sent[0].preferredNotificationWindow).toEqual([10, 11].map(toUtc));
        });

        it('with notifications off nothing is saved, but the caller is told', async () => {
            serverPersona({ notificationsEnabled: false });
            const sent = recordWindows();
            const onHoursChange = jest.fn();
            const { result } = await mount({ onHoursChange });
            useFakeClock(NOW);

            act(() => result.current.handleHoursChange([6]));
            await act(async () => {
                await jest.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS * 2);
            });

            expect(onHoursChange).toHaveBeenCalledWith([6]);
            expect(result.current.selectedHours).toEqual([6]);
            expect(sent).toEqual([]);
        });

        it('onboarding never auto-saves', async () => {
            const sent = recordWindows();
            const { result } = await mount({ isOnboarding: true });
            useFakeClock(NOW);

            act(() => result.current.handleHoursChange([6]));
            await act(async () => {
                await jest.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS * 2);
            });

            expect(sent).toEqual([]);
        });

        it('a failed save shows "Save Failed" and the error state', async () => {
            server.use(mockGqlError('UpdateNotificationWindow', 'INTERNAL_SERVER_ERROR'));
            const { result } = await mount();
            useFakeClock(NOW);

            act(() => result.current.handleHoursChange([6]));
            await act(async () => {
                await jest.advanceTimersByTimeAsync(AUTO_SAVE_DELAY_MS + 200);
            });

            await waitFor(() => expect(result.current.saveState).toBe('error'));
            expect(toastTitles()).toEqual(['Save Failed']);
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('turning notifications on', () => {
        beforeEach(() => {
            serverPersona({ notificationsEnabled: false });
        });

        it('permission granted: sends UpdateNotificationsEnabled(true), flips the switch and says so', async () => {
            const sent = recordMutation('UpdateNotificationsEnabled', 'updateNotificationsEnabled');
            const { result } = await mount();

            await act(async () => {
                await result.current.handleEnableNotifications();
            });

            expect(sent).toEqual([{ userId: FIXTURE_ACCOUNT.userId, enabled: true }]);
            expect(result.current.notificationsEnabled).toBe(true);
            expect(result.current.osRefused).toBe(false);
            expect(result.current.isEnabling).toBe(false);
            expect(toastTitles()).toEqual(['Notifications Enabled']);
        });

        it('asks the phone when it is not granted yet, and goes ahead when the person agrees', async () => {
            const sent = recordMutation('UpdateNotificationsEnabled', 'updateNotificationsEnabled');
            permissions.mockResolvedValue({ status: 'undetermined' });
            requestPermissions.mockResolvedValue({ status: 'granted' });
            const { result } = await mount();

            await act(async () => {
                await result.current.handleEnableNotifications();
            });

            expect(requestPermissions).toHaveBeenCalledTimes(1);
            expect(sent).toHaveLength(1);
            expect(result.current.notificationsEnabled).toBe(true);
        });

        it('permission refused: nothing is sent, osRefused is set and "Permission Required" shows', async () => {
            const sent = recordMutation('UpdateNotificationsEnabled', 'updateNotificationsEnabled');
            permissions.mockResolvedValue({ status: 'denied' });
            requestPermissions.mockResolvedValue({ status: 'denied' });
            const { result } = await mount();

            await act(async () => {
                await result.current.handleEnableNotifications();
            });

            expect(sent).toEqual([]);
            expect(result.current.notificationsEnabled).toBe(false);
            expect(result.current.osRefused).toBe(true);
            expect(toastTitles()).toEqual(['Permission Required']);
        });

        it('refused at the prompt just now: osRefused too', async () => {
            const { result } = await mount();
            // The status reads, in order: before asking, inside the service, after the refusal.
            permissions
                .mockResolvedValueOnce({ status: 'undetermined' })
                .mockResolvedValueOnce({ status: 'undetermined' })
                .mockResolvedValue({ status: 'denied' });
            requestPermissions.mockResolvedValue({ status: 'denied' });

            await act(async () => {
                await result.current.handleEnableNotifications();
            });

            expect(result.current.osRefused).toBe(true);
            expect(toastTitles()).toEqual(['Permission Required']);
        });

        it('permission granted but the server fails: "Setup Failed", still off', async () => {
            server.use(mockGqlError('UpdateNotificationsEnabled', 'INTERNAL_SERVER_ERROR'));
            const { result } = await mount();

            await act(async () => {
                await result.current.handleEnableNotifications();
            });

            expect(result.current.notificationsEnabled).toBe(false);
            expect(result.current.osRefused).toBe(false);
            expect(toastTitles()).toEqual(['Setup Failed']);
        });

        it('a new enableRequest nonce runs the turn-on flow; the first value is not a request', async () => {
            const sent = recordMutation('UpdateNotificationsEnabled', 'updateNotificationsEnabled');
            const { result, rerender } = await mount({ enableRequest: 1 });
            await new Promise((r) => setTimeout(r, 30));
            expect(sent).toEqual([]);

            rerender({ enableRequest: 2 });

            await waitFor(() => expect(sent).toHaveLength(1));
            await waitFor(() => expect(result.current.notificationsEnabled).toBe(true));
        });

        it('onEnabledChange reports each settled state, not the one in flight', async () => {
            recordMutation('UpdateNotificationsEnabled', 'updateNotificationsEnabled');
            const onEnabledChange = jest.fn();
            const { result } = await mount({ onEnabledChange });
            await waitFor(() => expect(onEnabledChange).toHaveBeenLastCalledWith(false));

            await act(async () => {
                await result.current.handleEnableNotifications();
            });

            await waitFor(() => expect(onEnabledChange).toHaveBeenLastCalledWith(true));
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('coming back from phone Settings', () => {
        beforeEach(() => {
            serverPersona({ notificationsEnabled: false });
            permissions.mockResolvedValue({ status: 'denied' });
        });

        // Refused, taps "Open Device Settings", leaves the app, comes back with `after` as the phone's answer.
        async function tripToSettings(after: 'granted' | 'denied') {
            const sent = recordMutation('UpdateNotificationsEnabled', 'updateNotificationsEnabled');
            const hook = await mount();
            await waitFor(() => expect(hook.result.current.osRefused).toBe(true));
            act(() => (hook.result.current as unknown as { openDeviceSettings?: () => void }).openDeviceSettings?.());
            setAppState('background');
            permissions.mockResolvedValue({ status: after });
            await act(async () => {
                setAppState('active');
                await new Promise((r) => setTimeout(r, 50));
            });
            return { ...hook, sent };
        }

        test.failing('returning from Settings with permission now granted finishes turning on: switch on, osRefused false, UpdateNotificationsEnabled(true) sent', async () => {
            const { result, sent } = await tripToSettings('granted');
            await waitFor(() => expect(result.current.notificationsEnabled).toBe(true));
            expect(result.current.osRefused).toBe(false);
            expect(sent).toEqual([{ userId: FIXTURE_ACCOUNT.userId, enabled: true }]);
        });

        it('today: returning from Settings with permission now granted leaves the switch off and sends nothing', async () => {
            const { result, sent } = await tripToSettings('granted');
            expect(result.current.notificationsEnabled).toBe(false);
            expect(result.current.osRefused).toBe(true);
            expect(sent).toEqual([]);
        });

        it('returning still refused changes nothing and shows no new toast', async () => {
            const { result, sent } = await tripToSettings('denied');
            expect(result.current.notificationsEnabled).toBe(false);
            expect(result.current.osRefused).toBe(true);
            expect(sent).toEqual([]);
            expect(toastTitles()).toEqual([]);
        });
    });

    // ---------------------------------------------------------------------------------------------
    describe('turning notifications off', () => {
        beforeEach(() => {
            serverPersona({ notificationsEnabled: true });
        });

        it('sends UpdateNotificationsEnabled(false), flips the switch and says so', async () => {
            const sent = recordMutation('UpdateNotificationsEnabled', 'updateNotificationsEnabled');
            const { result } = await mount();
            expect(result.current.notificationsEnabled).toBe(true);

            await act(async () => {
                await result.current.handleDisableNotifications();
            });

            expect(sent).toEqual([{ userId: FIXTURE_ACCOUNT.userId, enabled: false }]);
            expect(result.current.notificationsEnabled).toBe(false);
            expect(result.current.isDisabling).toBe(false);
            expect(toastTitles()).toEqual(['Notifications Disabled']);
            // Turning off never asks the phone for anything.
            expect(requestPermissions).not.toHaveBeenCalled();
        });

        // The service swallows a failed mutation and reports false; the hook must read it.
        test('NB1 a failed disable keeps the switch on and says "Update Failed"', async () => {
            server.use(mockGqlError('UpdateNotificationsEnabled', 'INTERNAL_SERVER_ERROR'));
            const { result } = await mount();

            await act(async () => {
                await result.current.handleDisableNotifications();
            });

            expect(result.current.notificationsEnabled).toBe(true);
            expect(toastTitles()).toEqual(['Update Failed']);
        });
    });
});
