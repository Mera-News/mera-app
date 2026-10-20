/* eslint-disable import/first, @typescript-eslint/no-require-imports -- the env must be set before the app modules load, so they are required in beforeAll */
// The "There's a problem with your account" gate (the auth screen's reauth-no-email stage): its two
// ways out, at the seam. useAccountProblem drives Contact support (Intercom, else mail) and Reset this
// phone (sign out + local wipe, never a server delete), and useAuthScreen leaves the gate for the
// sign-in track. Real auth client, stores, in-memory DB and keychain fake over MSW; the edges are the
// attestation module, Intercom's native half (setup mock) and expo-file-system.
//
// Intercom configures from env keys read when lib/config/endpoints first loads, so the env is set
// before any app module loads and the app modules are required in beforeAll.
process.env.EXPO_PUBLIC_INTERCOM_APP_ID = 'test_intercom_app';
process.env.EXPO_PUBLIC_INTERCOM_IOS_KEY = 'test_intercom_ios_key';

import Intercom from '@intercom/intercom-react-native';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Linking } from 'react-native';
import { settleDialog, useDialogQueue } from '@/lib/dialog';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { mockGqlError, secureStoreDump, server, useFakeClock } from '@/test/helpers';

// The model cache and the two backup directories, by name. Only the backup ones may ever go.
const mockExistingDirs = new Set<string>();
const mockDeleteLog: string[] = [];
jest.mock('expo-file-system', () => ({
    Paths: { document: 'doc://', cache: 'cache://' },
    Directory: class {
        name: string;
        constructor(_root: string, name: string) {
            this.name = name;
        }
        get exists() {
            return mockExistingDirs.has(this.name);
        }
        delete() {
            mockDeleteLog.push(this.name);
            mockExistingDirs.delete(this.name);
        }
    },
}));

jest.mock('@/modules/mera-device-attest', () => ({
    ...jest.requireActual('@/modules/mera-device-attest'),
    isSupported: () => Promise.resolve(false),
}));

const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const SUPPORT_ID = '1234567';
const SLUG = Constants.expoConfig?.slug || 'app';
const DEVICE_CREDENTIALS = ['appattest_key_id', 'appattest_key_proven', 'device_attest_device_id'].map((s) => `${SLUG}_${s}`);
const MODELS_DIR = 'mera-models';

let useAccountProblem: typeof import('@/components/custom/auth/useAccountProblem').useAccountProblem;
let useAuthScreen: typeof import('@/components/custom/auth/useAuthScreen').useAuthScreen;
let settings: typeof import('@/lib/database/services/setting-service');
let factService: typeof import('@/lib/database/services/fact-service');
let useUserStore: typeof import('@/lib/stores/user-store').useUserStore;
let useMeraProtocolStore: typeof import('@/lib/stores/mera-protocol-store').useMeraProtocolStore;
let secureStore: typeof import('@/lib/utils/secure-store-adapter').secureStore;
let IDENTITY_FAULT_KEY: string;

beforeAll(() => {
    ({ useAccountProblem } = require('@/components/custom/auth/useAccountProblem'));
    ({ useAuthScreen } = require('@/components/custom/auth/useAuthScreen'));
    settings = require('@/lib/database/services/setting-service');
    factService = require('@/lib/database/services/fact-service');
    ({ useUserStore } = require('@/lib/stores/user-store'));
    ({ useMeraProtocolStore } = require('@/lib/stores/mera-protocol-store'));
    ({ secureStore } = require('@/lib/utils/secure-store-adapter'));
    ({ IDENTITY_FAULT_KEY } = require('@/lib/security/identity-gate'));
    require('@/lib/security/install-boundary-latch').releaseAuthReadQuarantine();
});

let openURL: jest.SpyInstance;
let requests: string[];
let operations: string[];
const onRequest = ({ request }: { request: Request }) => {
    requests.push(new URL(request.url).pathname);
    if (request.method === 'POST' && request.url.includes('/graphql')) {
        void request
            .clone()
            .json()
            .then((b: { operationName?: string }) => b.operationName && operations.push(b.operationName))
            .catch(() => undefined);
    }
};

beforeEach(() => {
    mockExistingDirs.clear();
    mockDeleteLog.length = 0;
    requests = [];
    operations = [];
    // Real-clock timers (the Support ID read's timeout, toasts) would outlive the run.
    useFakeClock(Date.now(), { advanceTimers: true });
    server.events.on('request:start', onRequest);
    openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    require('@/lib/security/identity-gate').__resetIdentityStateForTests();
    require('@/lib/security/local-wipe').__resetLocalWipeForTests();
});

let inFlight = 0;
const onStart = () => (inFlight += 1);
const onEnd = () => (inFlight -= 1);
beforeAll(() => {
    server.events.on('request:start', onStart);
    server.events.on('request:end', onEnd);
});
afterAll(() => {
    server.events.removeListener('request:start', onStart);
    server.events.removeListener('request:end', onEnd);
});

afterEach(async () => {
    server.events.removeListener('request:start', onRequest);
    openURL.mockRestore();
    // The sign-out's session refetch can still be in flight; let it land before the next test.
    jest.useRealTimers();
    for (let quiet = 0, spent = 0; quiet < 3 && spent < 3000; spent += 25) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        quiet = inFlight === 0 ? quiet + 1 : 0;
    }
});

/** A phone stuck on the gate: an account id with no email, its Support ID, data, an on-device
 *  model and the persisted reauth and fault markers that put it there. */
async function seedStuckPhone(): Promise<void> {
    await settings.setSetting('cached_user_id', ME);
    await settings.setSetting('cached_support_id', SUPPORT_ID);
    await settings.setSetting('has_launched', '1');
    await settings.setSetting(IDENTITY_FAULT_KEY, '1');
    await factService.addFact('I follow Formula 1 racing');
    for (const credential of DEVICE_CREDENTIALS) await secureStore.setItemAsync(credential, 'device');
    useUserStore.setState({ userId: ME, needsReauth: false });
    useUserStore.getState().setNeedsReauth(true);
    useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.OnDevice);
    useMeraProtocolStore.getState().setSelectedModelId('qwen-test');
    mockExistingDirs.add(MODELS_DIR);
    mockExistingDirs.add('backup');
}

/** The gate screen as the stage mounts it: the auth screen's hook plus the stage's hook. */
function mountGate() {
    return renderHook(() => {
        const screen = useAuthScreen({});
        const gate = useAccountProblem({ onReset: screen.leaveGate });
        return { screen, gate };
    });
}

/** The store setters write fire-and-forget; WatermelonDB runs writes in order, so one more write
 *  landing means every write queued before it has landed. */
async function settledWrites(): Promise<void> {
    await settings.setSetting('test_write_barrier', '1');
}

async function answerDialog(confirm: boolean): Promise<void> {
    await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1), { timeout: 8000 });
    act(() => settleDialog(useDialogQueue.getState().queue[0].id, confirm));
}

it('the gate offers exactly two actions: contact support and reset this phone', async () => {
    await seedStuckPhone();
    const hook = mountGate();
    await waitFor(() => expect(hook.result.current.screen.stage).toBe('reauth-no-email'));

    const actions = Object.entries(hook.result.current.gate)
        .filter(([, v]) => typeof v === 'function')
        .map(([k]) => k)
        .sort();
    expect(actions).toEqual(['contactSupport', 'resetThisPhone']);
});

describe('contact support', () => {
    it('opens the Intercom Messenger when an identity can be minted', async () => {
        await seedStuckPhone();
        const hook = mountGate();

        await act(async () => {
            await hook.result.current.gate.contactSupport();
        });

        expect(Intercom.initialize).toHaveBeenCalled();
        expect(Intercom.present).toHaveBeenCalled();
        expect(openURL).not.toHaveBeenCalled();
    });

    it('signed out (no identity to mint), falls back to mail carrying the Support ID saved on this phone', async () => {
        await seedStuckPhone();
        server.use(mockGqlError('GetIntercomIdentity', 'UNAUTHENTICATED'));
        const hook = mountGate();

        await act(async () => {
            await hook.result.current.gate.contactSupport();
        });

        // Intercom was tried (the identity mint was asked for) and could not open.
        expect(operations).toContain('GetIntercomIdentity');
        expect(Intercom.setUserJwt).not.toHaveBeenCalled();
        expect(Intercom.present).not.toHaveBeenCalled();
        expect(openURL).toHaveBeenCalledTimes(1);
        expect(String(openURL.mock.calls[0][0])).toMatch(/^mailto:/);
        expect(decodeURIComponent(String(openURL.mock.calls[0][0]))).toContain(SUPPORT_ID);
    });
});

describe('reset this phone', () => {
    it('cancel changes nothing', async () => {
        await seedStuckPhone();
        const hook = mountGate();
        await waitFor(() => expect(hook.result.current.screen.stage).toBe('reauth-no-email'));

        let done!: Promise<void>;
        act(() => {
            done = hook.result.current.gate.resetThisPhone();
        });
        await answerDialog(false);
        await act(async () => {
            await done;
        });

        expect(await settings.getSetting('cached_user_id')).toBe(ME);
        expect(await factService.hasAnyFacts()).toBe(true);
        expect(router.replace).not.toHaveBeenCalled();
        expect(hook.result.current.screen.stage).toBe('reauth-no-email');
        expect(requests.filter((p) => p.includes('sign-out'))).toEqual([]);
    });

    it('confirm signs out and wipes this phone, keeps the account and the models, and leaves the gate for sign-in', async () => {
        await seedStuckPhone();
        const hook = mountGate();
        await waitFor(() => expect(hook.result.current.screen.stage).toBe('reauth-no-email'));

        let done!: Promise<void>;
        act(() => {
            done = hook.result.current.gate.resetThisPhone();
        });
        await answerDialog(true);
        await act(async () => {
            await done;
        });

        // Signed out and wiped locally.
        expect(await factService.hasAnyFacts()).toBe(false);
        expect(secureStoreDump()[`${SLUG}_cookie`]).toBeUndefined();
        expect(router.replace).toHaveBeenCalledWith({ pathname: '/login', params: { signedOut: '1' } });
        // The gate's state is gone, so no launch lands here again.
        expect(await settings.getSetting('cached_user_id')).toBeNull();
        expect(await settings.getSetting('cached_support_id')).toBeNull();
        expect(await settings.getSetting('needs_reauth')).toBeNull();
        expect(await settings.getSetting(IDENTITY_FAULT_KEY)).toBeNull();
        expect(useUserStore.getState()).toMatchObject({ userId: null, needsReauth: false });
        expect(hook.result.current.screen.stage).not.toBe('reauth-no-email');
        expect(hook.result.current.screen).toMatchObject({ cachedUserId: null, supportId: null });
        // The server account is untouched: no deletion request, and the device binding survives so
        // signing in with this phone again resumes the same account.
        expect(requests.filter((p) => p.includes('account-deletion'))).toEqual([]);
        for (const credential of DEVICE_CREDENTIALS) expect(secureStoreDump()[credential]).toBe('device');
        // Downloaded models stay: the directory is never deleted, and the next boot still reads
        // on-device processing, so use-app-root does not purge them either.
        expect(mockDeleteLog).not.toContain(MODELS_DIR);
        expect(mockExistingDirs.has(MODELS_DIR)).toBe(true);
        await settledWrites();
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud, selectedModelId: '' });
        await useMeraProtocolStore.getState().hydrateFromDb();
        expect(useMeraProtocolStore.getState()).toMatchObject({
            processingMode: ProcessingMode.OnDevice,
            selectedModelId: 'qwen-test',
        });
    });

    it('a cloud phone stays cloud after the reset (nothing is restored that was not there)', async () => {
        await seedStuckPhone();
        useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.Cloud);
        const hook = mountGate();
        await waitFor(() => expect(hook.result.current.screen.stage).toBe('reauth-no-email'));

        let done!: Promise<void>;
        act(() => {
            done = hook.result.current.gate.resetThisPhone();
        });
        await answerDialog(true);
        await act(async () => {
            await done;
        });

        await settledWrites();
        expect(await settings.getSetting('mera_processing_mode')).toBeNull();
    });
});
