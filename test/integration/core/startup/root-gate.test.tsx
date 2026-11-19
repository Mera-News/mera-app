// The real root layout behind the foreground gate. A foreground start renders the whole tree in its
// first commit, as before; a background or unknown start renders nothing, starts nothing and sends
// nothing until the first `active`. The mocks below are the start-up calls a background launch must
// never make; each is also shown to happen once the gate opens, so a zero is never vacuous.
import { act, render } from '@testing-library/react-native';
import React from 'react';
import NetInfo from '@react-native-community/netinfo';
import { recordRequests } from '@/test/helpers/wake-census';
import { appStateModule, setAppState } from '@/test/helpers/app-state';
import { isForegroundGateOpen, resetForegroundGateForTests } from '@/lib/startup/foreground-gate';
import { handleInitialNotification } from '@/lib/notification-service';
import { stopNetworkListener } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';
import { inferenceQueue } from '@/lib/inference/InferenceQueue';

const mockUseSession = jest.fn(() => ({ data: null, isPending: false }));
jest.mock('@/lib/auth-client', () => {
    const actual = jest.requireActual('@/lib/auth-client');
    return {
        ...actual,
        authClient: new Proxy(actual.authClient, {
            get: (target, key) => (key === 'useSession' ? mockUseSession : target[key]),
        }),
    };
});

const mockConfigureRevenueCat = jest.fn();
const mockCustomerInfo = jest.fn(() => Promise.resolve(null));
jest.mock('@/lib/revenuecat', () => ({
    ...jest.requireActual('@/lib/revenuecat'),
    configureRevenueCat: () => mockConfigureRevenueCat(),
    getCustomerInfoSafe: () => mockCustomerInfo(),
    addCustomerInfoUpdateListener: () => () => {},
}));

const mockEnsurePushToken = jest.fn(() => Promise.resolve());
jest.mock('@/lib/notification-service', () => ({
    ...jest.requireActual('@/lib/notification-service'),
    ensurePushTokenRegistered: (...a: unknown[]) => mockEnsurePushToken(...(a as [])),
    setupNotifications: jest.fn(),
    handleInitialNotification: jest.fn(() => Promise.resolve()),
}));

// The client's boot runs `afterHydrate` (the push-token re-registration) once the stores are read.
const mockStartClient = jest.fn((opts: { afterHydrate?: () => void }) => {
    opts.afterHydrate?.();
    return () => {};
});
jest.mock('@/lib/scheduler/start-client', () => ({ startClient: (opts: never) => mockStartClient(opts) }));

// The version check would ask Mera; a pass-through records when the tree below it first renders.
const mockTreeRenders = jest.fn();
jest.mock('@/components/custom/NativeUpdateGate', () => ({
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => {
        mockTreeRenders();
        return children;
    },
}));

// The navigator renders the real launch screen (app/index), which reads the session.
jest.mock('expo-router', () => {
    const Stack = () => {
        const Index = require('@/app/index').default;
        return <Index />;
    };
    Stack.Screen = function Screen() {
        return null;
    };
    return {
        Stack,
        Redirect: () => null,
        ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
        DarkTheme: { dark: true, colors: {}, fonts: {} },
        DefaultTheme: { dark: false, colors: {}, fonts: {} },
        useNavigationContainerRef: () => ({ isReady: () => true }),
        usePathname: () => '/',
        router: { replace: jest.fn(), push: jest.fn(), navigate: jest.fn() },
    };
});

jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));
// Overlays that draw over the tree; not start-up work, and their native parts cannot load here.
jest.mock('@/components/custom/toast/ToastDeck', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/theme-crossfade', () => ({ ThemeCrossfade: () => null }));
jest.mock('@/global.css', () => ({}));
// Styling providers (NativeWind cannot switch its scheme here); not start-up work.
jest.mock('@/components/ui/gluestack-ui-provider', () => ({
    GluestackUIProvider: ({ children }: { children: React.ReactNode }) => children,
}));

let census: ReturnType<typeof recordRequests>;
let view: { unmount: () => void } | null = null;

beforeEach(() => {
    census = recordRequests();
    useUserStore.setState({ userId: 'user-1' });
});
afterEach(async () => {
    // The tree starts the inference queue's loop; stop it so nothing runs on after this file.
    view?.unmount();
    view = null;
    await inferenceQueue.stop();
    void census.stop();
    stopNetworkListener();
    appStateModule.currentState = 'active';
    resetForegroundGateForTests();
});

// Loading the root layout holds the splash with a capped timer; release it so no timer outlives the file.
afterAll(() => require('@/lib/splash-hold').releaseSplash('test'));

async function launchIn(state: string) {
    appStateModule.currentState = state as never;
    resetForegroundGateForTests();
    const RootLayout = require('@/app/_layout').default;
    view = await render(<RootLayout />);
    await act(async () => {});
    return view;
}

function expectNothingStarted() {
    expect(mockTreeRenders).not.toHaveBeenCalled();
    expect(mockUseSession).not.toHaveBeenCalled();
    expect(mockConfigureRevenueCat).not.toHaveBeenCalled();
    expect(mockCustomerInfo).not.toHaveBeenCalled();
    expect(mockEnsurePushToken).not.toHaveBeenCalled();
    expect(mockStartClient).not.toHaveBeenCalled();
    expect(NetInfo.configure).not.toHaveBeenCalled();
    expect(NetInfo.fetch).not.toHaveBeenCalled();
    expect(handleInitialNotification).not.toHaveBeenCalled();
    const { router } = jest.requireMock('expo-router');
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(census.hosts()).toEqual([]);
}

function expectEverythingStarted() {
    expect(mockUseSession).toHaveBeenCalled();
    expect(mockConfigureRevenueCat).toHaveBeenCalledTimes(1);
    expect(mockCustomerInfo).toHaveBeenCalledTimes(1);
    expect(mockStartClient).toHaveBeenCalledTimes(1);
    expect(mockEnsurePushToken).toHaveBeenCalledWith('user-1');
    expect(NetInfo.configure).toHaveBeenCalledTimes(1);
    expect(NetInfo.fetch).toHaveBeenCalledTimes(1);
    // A launch from a notification tap is handled as before, once navigation is ready.
    expect(handleInitialNotification).toHaveBeenCalled();
}

describe.each(['active', 'inactive'])('a foreground start (read as %s)', (state) => {
    it('renders the whole tree in its first commit and starts everything, as before', async () => {
        appStateModule.currentState = state as never;
        resetForegroundGateForTests();
        // Open before the first render: the root renders its tree on that render, with no empty frame.
        expect(isForegroundGateOpen()).toBe(true);
        await launchIn(state);
        expect(mockTreeRenders).toHaveBeenCalled();
        expectEverythingStarted();
    });
});

describe.each(['background', 'unknown'])('a start read as %s', (state) => {
    it('renders and starts nothing and sends no request until the first active', async () => {
        await launchIn(state);
        expectNothingStarted();

        await act(async () => setAppState('active'));
        expect(mockTreeRenders).toHaveBeenCalled();
        expectEverythingStarted();
    });

    it('renders and starts nothing when it never comes to the foreground', async () => {
        await launchIn(state);
        await act(async () => setAppState('background'));
        expectNothingStarted();
    });
});

it('lets reachability probes run only while the app is active', async () => {
    await launchIn('active');
    const { reachabilityShouldRun } = jest.mocked(NetInfo.configure).mock.calls[0][0] as { reachabilityShouldRun: () => boolean };
    for (const [state, runs] of [['active', true], ['background', false], ['inactive', false]] as const) {
        appStateModule.currentState = state;
        expect(reachabilityShouldRun()).toBe(runs);
    }
});
