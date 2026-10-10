/* eslint-disable import/first, @typescript-eslint/no-require-imports -- the env must be set before the app modules load, so they are required in beforeAll */
// Logout, the local wipe and account deletion, at their seams: the real hooks, auth client, stores,
// in-memory DB and keychain fake against the mock backend. Edges faked: native modules
// (expo-file-system here) and the SDK wrappers' native halves (RevenueCat and Intercom, whose
// mocks live in the setup).
//
// Intercom only talks to its SDK once it is configured, and it configures from env keys read when
// lib/config/endpoints first loads. So the env is set before any app module loads, and every app
// module that reaches the endpoints is required in beforeAll rather than imported.
process.env.EXPO_PUBLIC_INTERCOM_APP_ID = 'test_intercom_app';
process.env.EXPO_PUBLIC_INTERCOM_IOS_KEY = 'test_intercom_ios_key';
// Google Drive likewise: disconnectGoogleDrive() is a no-op unless the web client id is set when
// lib/config/endpoints first loads (invariant 4b tests below).
process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID = 'test_google_web_client_id';

import AsyncStorage from '@react-native-async-storage/async-storage';
import Intercom from '@intercom/intercom-react-native';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { TurboModuleRegistry } from 'react-native';
import Purchases from 'react-native-purchases';
import type SettingModel from '@/lib/database/models/Setting';
import { settleDialog, useDialogQueue } from '@/lib/dialog';
import {
    FIXTURE_ACCOUNT,
    HttpResponse,
    advanceUntilDone,
    failSecureStore,
    http,
    secureStoreDump,
    server,
    signInFixtureAccount,
    useFakeClock,
} from '@/test/helpers';

// Mutable fake of the two backup directories the wipe deletes (the only filesystem step it has).
const mockExistingDirs = new Set<string>();
const mockDeleteLog: string[] = [];
let mockOnDirDelete: ((name: string) => void) | null = null;
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
            mockOnDirDelete?.(this.name);
            mockDeleteLog.push(this.name);
            mockExistingDirs.delete(this.name);
        }
    },
}));

const ME = FIXTURE_ACCOUNT.userId;
const SLUG = Constants.expoConfig?.slug || 'app';
const key = (suffix: string) => `${SLUG}_${suffix}`;

/** local-wipe.ts SECURE_STORE_KEYS, restated (the constant is not exported). */
const SECURE_STORE_KEYS = [
    key('cookie'),
    key('session_data'),
    key('pin_record'),
    key('pin_attempts'),
    key('app_lock_enabled'),
    key('backup_key'),
    'async_pipeline_privkey',
    'async_inference_pending_job_privkey',
];
/** The once-per-DEVICE PIN reset marker: it outlives every wipe, so the reset never re-runs (PE19). */
const PIN_RESET_MARKER = key('pin_force_reset_v1');
/** Survive every sign-out on purpose, so logging in again resumes the same account (S10). */
const DEVICE_CREDENTIALS = ['appattest_key_id', 'appattest_key_proven', 'device_attest_device_id'].map(key);
/** Everything a wipe leaves in the keychain. */
const SURVIVORS = [...DEVICE_CREDENTIALS, PIN_RESET_MARKER];

/** The only AsyncStorage key the app has ever written (a since-deleted capability token). */
const CAPABILITY_TOKEN = 'mera.cycle.capabilityToken';

const LOGIN_SIGNED_OUT = { pathname: '/login', params: { signedOut: '1' } };
const replaced = () => jest.mocked(router.replace).mock.calls;

type Mod<T> = T;
let authClient: Mod<typeof import('@/lib/auth-client').authClient>;
let useAppPreferences: typeof import('@/components/custom/config-mera/useAppPreferences').useAppPreferences;
let useDeleteAccount: typeof import('@/components/custom/config-mera/use-delete-account').useDeleteAccount;
let useServerErrorLogout: typeof import('@/components/custom/onboarding/useServerErrorLogout').useServerErrorLogout;
let settings: typeof import('@/lib/database/services/setting-service');
let factService: typeof import('@/lib/database/services/fact-service');
let personaService: typeof import('@/lib/database/services/user-persona-service');
let wipe: typeof import('@/lib/security/local-wipe');
let launchRoute: typeof import('@/lib/security/launch-route');
let database: typeof import('@/lib/database').default;
let usePinStore: typeof import('@/lib/stores/pin-store').usePinStore;
let useUserStore: typeof import('@/lib/stores/user-store').useUserStore;
let authModule: typeof import('@/lib/auth-client');
let secureStore: typeof import('@/lib/utils/secure-store-adapter').secureStore;
let resetIdentity: () => void;
let resetBreaker: () => void;
let resetQuarantine: () => void;

let inFlight = 0;
const onStart = () => {
    inFlight += 1;
};
const onEnd = () => {
    inFlight -= 1;
};
/** Waits until no request is in flight for three consecutive ticks (bounded). */
async function drain(): Promise<void> {
    for (let quiet = 0, spent = 0; quiet < 3 && spent < 3000; spent += 25) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        quiet = inFlight === 0 ? quiet + 1 : 0;
    }
}

const sessionAtom = () =>
    (authClient as unknown as { $store: { atoms: { session: { get(): any; set(v: unknown): void } } } }).$store.atoms
        .session;
async function signIn(): Promise<void> {
    await signInFixtureAccount();
    const { data } = await authClient.getSession();
    sessionAtom().set({ ...sessionAtom().get(), data, error: null, isPending: false, isRefetching: false });
}

const spies: jest.SpyInstance[] = [];
const track = <T extends jest.SpyInstance>(spy: T): T => {
    spies.push(spy);
    return spy;
};

let registrySpy: jest.SpyInstance;
beforeAll(async () => {
    // google-drive.ts caches its "is the native module linked" probe on first use, so the link must
    // be in place before any test reaches it. Only RNGoogleSignin is answered; the rest passes through.
    const realGet = TurboModuleRegistry.get.bind(TurboModuleRegistry);
    registrySpy = jest
        .spyOn(TurboModuleRegistry, 'get')
        .mockImplementation(((name: string) => (name === 'RNGoogleSignin' ? {} : realGet(name))) as never);
    server.events.on('request:start', onStart);
    server.events.on('request:end', onEnd);
    authModule = require('@/lib/auth-client');
    authClient = authModule.authClient;
    ({ useAppPreferences } = require('@/components/custom/config-mera/useAppPreferences'));
    ({ useDeleteAccount } = require('@/components/custom/config-mera/use-delete-account'));
    ({ useServerErrorLogout } = require('@/components/custom/onboarding/useServerErrorLogout'));
    settings = require('@/lib/database/services/setting-service');
    factService = require('@/lib/database/services/fact-service');
    personaService = require('@/lib/database/services/user-persona-service');
    wipe = require('@/lib/security/local-wipe');
    launchRoute = require('@/lib/security/launch-route');
    database = require('@/lib/database').default;
    ({ usePinStore } = require('@/lib/stores/pin-store'));
    ({ useUserStore } = require('@/lib/stores/user-store'));
    ({ secureStore } = require('@/lib/utils/secure-store-adapter'));
    resetIdentity = require('@/lib/security/identity-gate').__resetIdentityStateForTests;
    resetBreaker = require('@/lib/auth-failure-breaker')._resetForTests;
    resetQuarantine = require('@/lib/security/install-boundary-latch').__resetAuthReadQuarantineForTests;
    require('@/lib/revenuecat').configureRevenueCat();
    // Guard: with the env set too late Intercom would never configure and every Intercom assertion
    // below would be vacuous.
    const intercom = require('@/lib/intercom') as typeof import('@/lib/intercom');
    expect(intercom.isIntercomEnabled()).toBe(true);
    expect(await intercom.configureIntercom()).toBe(true);
});

afterAll(() => {
    registrySpy.mockRestore();
    server.events.removeListener('request:start', onStart);
    server.events.removeListener('request:end', onEnd);
});

/** The SDK's own answer to "is a Google account connected": the setup mock defaults to false. */
const driveConnected = (connected: boolean) => jest.mocked(GoogleSignin.hasPreviousSignIn).mockReturnValue(connected);

beforeEach(() => {
    driveConnected(true);
    inFlight = 0;
    mockExistingDirs.clear();
    mockDeleteLog.length = 0;
    mockOnDirDelete = null;
    resetIdentity();
    wipe.__resetLocalWipeForTests();
    require('@/components/custom/auth/legal-consent').__resetLegalConsentLatchForTests();
    require('@/components/custom/auth/useLoggedInGate').__resetLoggedInGateForTests();
    resetBreaker();
    resetQuarantine();
    usePinStore.setState({
        pinSet: false,
        lockEnabled: false,
        locked: false,
        lastBackgroundedAt: null,
        initialized: false,
    });
    useUserStore.setState({
        userId: null,
        userEmail: null,
        userPersona: null,
        isLoading: false,
        lastFetchedAt: null,
        needsReauth: false,
    });
    sessionAtom().set({ ...sessionAtom().get(), data: null, error: null, isPending: false, isRefetching: false });
});

afterEach(async () => {
    cleanup();
    jest.useRealTimers();
    await drain();
    while (spies.length) spies.pop()?.mockRestore();
});

// ---------------------------------------------------------------------------------------------
// Seeds, through the app's own services.
// ---------------------------------------------------------------------------------------------

/** A signed-in device that holds everything a logout has to take: a fact, a PIN with the lock on,
 *  a backup key, both E2EE keys, the identity stamp and the device credentials. */
async function seedSignedInDevice(): Promise<void> {
    await signIn();
    await settings.setSetting('cached_user_id', ME);
    await settings.setSetting('has_launched', '1');
    await factService.addFact('I follow Formula 1 racing');
    await require('@/lib/security/pin-service').setPin('1234');
    await require('@/lib/security/app-lock-service').setAppLockEnabled(true);
    usePinStore.setState({ pinSet: true, lockEnabled: true });
    await require('@/lib/backup/key-store').ensureBackupKey();
    await secureStore.setItemAsync('async_pipeline_privkey', 'pipeline-key');
    await secureStore.setItemAsync('async_inference_pending_job_privkey', 'legacy-key');
    await secureStore.setItemAsync(key('pin_attempts'), '{"failCount":1,"lockedUntil":0}');
    await secureStore.setItemAsync(key('pin_force_reset_v1'), '1');
    for (const credential of DEVICE_CREDENTIALS) await secureStore.setItemAsync(credential, 'device');
    await AsyncStorage.setItem(CAPABILITY_TOKEN, 'capability');
    useUserStore.setState({ userId: ME });
}

/** What the keychain still holds. The sign-out refetch may re-cache the signed-out session as the
 *  string "null" after the wipe; that carries no session, so it does not count. */
function secrets(): Record<string, string> {
    const dump = secureStoreDump();
    if (dump[key('session_data')] === 'null') delete dump[key('session_data')];
    return dump;
}

/** Settings rows still on disk. The cleared feed store re-persists its zeroed counters
 *  (`feed_metadata`: counts, no identity) a moment after the reset, so that one row is not residue. */
async function leftoverSettings(): Promise<string[]> {
    const rows = await database.get<SettingModel>('settings').query().fetch();
    return rows.map((r) => r.key).filter((k) => k !== 'feed_metadata');
}

/** The outcome shared by every sign-out: nothing of the account is left but the device credentials. */
async function expectSignedOutAndWiped(): Promise<void> {
    const left = secrets();
    for (const k of SECURE_STORE_KEYS) expect(left[k]).toBeUndefined();
    expect(Object.keys(left).sort()).toEqual([...SURVIVORS].sort());
    expect(await AsyncStorage.getItem(CAPABILITY_TOKEN)).toBeNull();
    expect(await settings.getSetting('cached_user_id')).toBeNull();
    expect(await leftoverSettings()).toEqual([]);
    expect(await factService.hasAnyFacts()).toBe(false);
    expect(usePinStore.getState()).toMatchObject({ pinSet: false, lockEnabled: false, locked: false });
    expect(useUserStore.getState().userId).toBeNull();
    // The two SDKs that hold identity natively are signed out too.
    expect(Purchases.logOut).toHaveBeenCalled();
    expect(Intercom.logout).toHaveBeenCalled();
    expect(await launchRoute.readLocalIdentityState()).toBe('absent');
}

/** Starts `run`, answers each dialog it raises with "confirm", and returns once it has finished. */
async function runConfirming(run: () => Promise<void>, dialogs = 1, onLastDialog?: () => void): Promise<void> {
    const done = run();
    for (let i = 0; i < dialogs; i += 1) {
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1), { timeout: 8000 });
        if (i === dialogs - 1) onLastDialog?.();
        act(() => settleDialog(useDialogQueue.getState().queue[0].id, true));
    }
    await act(async () => {
        await done;
    });
}

// ---------------------------------------------------------------------------------------------
// The explicit logout button
// ---------------------------------------------------------------------------------------------

describe('logout button (useAppPreferences.confirmLogout)', () => {
    const mount = () => renderHook(() => useAppPreferences());

    it('signs out, erases every local secret and row, resets the SDKs and lands on the signed-out login', async () => {
        await seedSignedInDevice();
        // Positive controls: the device really holds every key before the button is pressed.
        for (const k of SECURE_STORE_KEYS) expect(secureStoreDump()[k]).toBeDefined();
        const { result } = mount();

        await runConfirming(() => result.current.confirmLogout());

        await expectSignedOutAndWiped();
        expect(replaced()).toEqual([[LOGIN_SIGNED_OUT]]);
    });

    // Invariant 4b: a Drive left connected uploads the next person's persona into a stranger's Drive.
    it('disconnects Google Drive', async () => {
        await seedSignedInDevice();
        const { result } = mount();

        await runConfirming(() => result.current.confirmLogout());

        expect(GoogleSignin.signOut).toHaveBeenCalled();
    });

    it('with no Drive connected, never signs Google out and still completes', async () => {
        driveConnected(false);
        await seedSignedInDevice();
        const { result } = mount();

        await runConfirming(() => result.current.confirmLogout());

        expect(GoogleSignin.hasPreviousSignIn).toHaveBeenCalled();
        expect(GoogleSignin.signOut).not.toHaveBeenCalled();
        await expectSignedOutAndWiped();
    });

    it('declining the dialog changes nothing', async () => {
        await seedSignedInDevice();
        const { result } = mount();

        const done = result.current.confirmLogout();
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        act(() => settleDialog(useDialogQueue.getState().queue[0].id, false));
        await done;

        expect(await settings.getSetting('cached_user_id')).toBe(ME);
        expect(secureStoreDump()[key('cookie')]).toBeDefined();
        expect(await factService.hasAnyFacts()).toBe(true);
        expect(replaced()).toEqual([]);
    });

    it('gives the same outcome when the server sign-out answers 500', async () => {
        server.use(
            http.post('*/api/auth/sign-out', () => HttpResponse.json({ message: 'boom' }, { status: 500 })),
        );
        await seedSignedInDevice();
        const { result } = mount();

        await runConfirming(() => result.current.confirmLogout());

        await expectSignedOutAndWiped();
        expect(replaced()).toEqual([[LOGIN_SIGNED_OUT]]);
    });

    it('gives the same outcome when the server sign-out never answers, bounded by the 5 s race', async () => {
        let answerLate!: () => void;
        server.use(
            http.post('*/api/auth/sign-out', async () => {
                await new Promise<void>((resolve) => {
                    answerLate = resolve;
                });
                return HttpResponse.json({ success: true });
            }),
        );
        await seedSignedInDevice();
        const { result } = mount();

        const done = result.current.confirmLogout();
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1), { timeout: 8000 });
        // Fake only from here, so the 5 s race and the post-navigation yield run on the test's clock.
        useFakeClock(Date.now());
        act(() => settleDialog(useDialogQueue.getState().queue[0].id, true));
        await advanceUntilDone(done);

        await expectSignedOutAndWiped();
        expect(replaced()).toEqual([[LOGIN_SIGNED_OUT]]);
        jest.useRealTimers();
        answerLate();
    });
});

// ---------------------------------------------------------------------------------------------
// signOutAndWipe, the escape from the identity-switch failure screen
// ---------------------------------------------------------------------------------------------

describe('signOutAndWipe', () => {
    it('gives the same outcome as the button', async () => {
        await seedSignedInDevice();

        await wipe.signOutAndWipe();

        await expectSignedOutAndWiped();
        expect(replaced()).toEqual([[LOGIN_SIGNED_OUT]]);
    });

    it('disconnects Google Drive', async () => {
        await seedSignedInDevice();

        await wipe.signOutAndWipe();

        expect(GoogleSignin.signOut).toHaveBeenCalled();
    });

    it('with no Drive connected, never signs Google out and still completes', async () => {
        driveConnected(false);
        await seedSignedInDevice();

        await wipe.signOutAndWipe();

        expect(GoogleSignin.hasPreviousSignIn).toHaveBeenCalled();
        expect(GoogleSignin.signOut).not.toHaveBeenCalled();
        await expectSignedOutAndWiped();
    });

    it('signs out and drops the identity sentinel, NAVIGATES, and only then erases', async () => {
        await seedSignedInDevice();
        let atNavigation: {
            secrets: Record<string, string>;
            sentinel: Promise<string | null>;
            facts: Promise<boolean>;
            capability: Promise<string | null>;
        };
        jest.mocked(router.replace).mockImplementationOnce(() => {
            atNavigation = {
                secrets: secureStoreDump(),
                sentinel: settings.getSetting('cached_user_id'),
                facts: factService.hasAnyFacts(),
                capability: AsyncStorage.getItem(CAPABILITY_TOKEN),
            };
        });

        await wipe.signOutAndWipe();

        // The session is gone and the sentinel dropped before any gate can run against them...
        expect(atNavigation!.secrets[key('cookie')]).toBeUndefined();
        expect(await atNavigation!.sentinel).toBeNull();
        // ...but nothing else is erased yet: THE PROPERTY. The escape works even when the erase breaks.
        expect(atNavigation!.secrets[key('pin_record')]).toBeDefined();
        expect(await atNavigation!.facts).toBe(true);
        expect(await atNavigation!.capability).toBe('capability');
        expect(await factService.hasAnyFacts()).toBe(false);
    });

    it('still erases when sign-out itself throws', async () => {
        await seedSignedInDevice();
        track(jest.spyOn(authModule, 'clearAuthStorage')).mockRejectedValueOnce(new Error('network down'));

        await wipe.signOutAndWipe();

        // Half-signed-out is the dangerous state, so the erase is exactly what must not be skipped.
        expect(await factService.hasAnyFacts()).toBe(false);
        expect(secureStoreDump()[key('pin_record')]).toBeUndefined();
        expect(replaced()).toEqual([[LOGIN_SIGNED_OUT]]);
    });

    it('still erases when the navigation throws', async () => {
        await seedSignedInDevice();
        jest.mocked(router.replace).mockImplementationOnce(() => {
            throw new Error('no navigator');
        });

        await wipe.signOutAndWipe();

        expect(await factService.hasAnyFacts()).toBe(false);
        expect(secureStoreDump()[key('pin_record')]).toBeUndefined();
    });

    it('propagates a failed erase: the caller decides what that means, but the person is already out', async () => {
        await seedSignedInDevice();
        track(jest.spyOn(database, 'unsafeResetDatabase')).mockRejectedValueOnce(new Error('database is locked'));

        await expect(wipe.signOutAndWipe()).rejects.toThrow('database is locked');

        expect(replaced()).toEqual([[LOGIN_SIGNED_OUT]]);
        expect(secureStoreDump()[key('cookie')]).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------------------------
// wipeAllLocalUserData
// ---------------------------------------------------------------------------------------------

describe('wipeAllLocalUserData', () => {
    it('a full wipe clears every secret but the device-level markers and leaves has_launched gone: that device reads as signed out', async () => {
        await seedSignedInDevice();
        expect(await settings.getSetting('has_launched')).toBe('1');

        await wipe.wipeAllLocalUserData();

        const left = secrets();
        for (const k of SECURE_STORE_KEYS) expect(left[k]).toBeUndefined();
        expect(Object.keys(left).sort()).toEqual([...SURVIVORS].sort());
        // The S10 inversion: the device credentials are deliberately not in the list.
        expect(await settings.getSetting('has_launched')).toBeNull();
        expect(await AsyncStorage.getItem(CAPABILITY_TOKEN)).toBeNull();
        expect(await leftoverSettings()).toEqual([]);
        expect(usePinStore.getState()).toMatchObject({ pinSet: false, lockEnabled: false });
        expect(Purchases.logOut).toHaveBeenCalled();
    });

    // An ACCOUNT SWITCH: the session keys belong to the account that just signed in, so they are the
    // ONLY thing spared. Every other secret of the previous account still goes.
    it('keepSession spares only the incoming session, erases the rest, and writes has_launched back (invariant 18)', async () => {
        await seedSignedInDevice();
        const session = {
            cookie: secureStoreDump()[key('cookie')],
            sessionData: secureStoreDump()[key('session_data')],
        };
        expect(session.cookie).toBeDefined();

        await wipe.wipeAllLocalUserData({ keepSession: true });

        const left = secureStoreDump();
        expect(left[key('cookie')]).toBe(session.cookie);
        expect(left[key('session_data')]).toBe(session.sessionData);
        for (const k of SECURE_STORE_KEYS.slice(2)) expect(left[k]).toBeUndefined();
        expect(await settings.getSetting('has_launched')).toBe('1');
        expect(await AsyncStorage.getItem(CAPABILITY_TOKEN)).toBeNull();
        expect(await settings.getSetting('cached_user_id')).toBeNull();
        expect(await factService.hasAnyFacts()).toBe(false);
        expect(usePinStore.getState()).toMatchObject({ pinSet: false, lockEnabled: false });
        expect(Purchases.logOut).toHaveBeenCalled();
    });

    describe('the one-shot PIN reset marker', () => {
        /**
         * The force reset ran once on this install, then the device was wiped (a logout, or an
         * account switch with `keepSession`); the person signs in, opts into the lock and the app
         * launches again. Returns what the pin store reads on that launch.
         */
        async function launchAfterWipeAndOptIn(opts?: { keepSession: true }) {
            const { runPinForceResetOnce } = require('@/lib/security/pin-force-reset');
            await runPinForceResetOnce();
            await seedSignedInDevice();
            await wipe.wipeAllLocalUserData(opts);
            if (!opts) await signIn();
            await require('@/lib/security/pin-service').setPin('1234');
            await require('@/lib/security/app-lock-service').setAppLockEnabled(true);
            usePinStore.setState({
                pinSet: false,
                lockEnabled: false,
                locked: false,
                lastBackgroundedAt: null,
                initialized: false,
            });
            await usePinStore.getState().init();
            const read = usePinStore.getState();
            usePinStore.getState().unlock(); // releases the pin-lock restart hold init took
            return { pinSet: read.pinSet, lockEnabled: read.lockEnabled };
        }

        test(
            'PE19 logout keeps the one-shot PIN reset marker, so a lock turned on after it survives the next launch',
            async () => {
                expect(await launchAfterWipeAndOptIn()).toEqual({ lockEnabled: true, pinSet: true });
            },
        );

        test(
            'PE19 the account-switch wipe keeps the one-shot PIN reset marker, so a lock turned on after it survives the next launch',
            async () => {
                expect(await launchAfterWipeAndOptIn({ keepSession: true })).toEqual({
                    lockEnabled: true,
                    pinSet: true,
                });
            },
        );
    });

    it('disconnects Google Drive', async () => {
        await seedSignedInDevice();

        await wipe.wipeAllLocalUserData();

        expect(GoogleSignin.signOut).toHaveBeenCalled();
    });

    it('with no Drive connected, never signs Google out and still wipes', async () => {
        driveConnected(false);
        await seedSignedInDevice();

        await wipe.wipeAllLocalUserData();

        expect(GoogleSignin.hasPreviousSignIn).toHaveBeenCalled();
        expect(GoogleSignin.signOut).not.toHaveBeenCalled();
        expect(await factService.hasAnyFacts()).toBe(false);
        expect(secureStoreDump()[key('pin_record')]).toBeUndefined();
    });

    it('a failing keychain delete does not stop the database wipe', async () => {
        await seedSignedInDevice();
        failSecureStore(key('pin_record'), 'delete');

        await wipe.wipeAllLocalUserData();

        expect(await factService.hasAnyFacts()).toBe(false);
        expect(secureStoreDump()[key('backup_key')]).toBeUndefined();
        expect(secureStoreDump().async_pipeline_privkey).toBeUndefined();
    });

    it('a failing RevenueCat logout does not stop the database wipe', async () => {
        await seedSignedInDevice();
        jest.mocked(Purchases.logOut).mockRejectedValueOnce(new Error('rc offline'));

        await wipe.wipeAllLocalUserData();

        expect(Purchases.logOut).toHaveBeenCalled();
        expect(await factService.hasAnyFacts()).toBe(false);
    });

    describe('the staged backup blob and the exporter scratch directory', () => {
        // A backup blob is the person's whole persona in one file; the wipe used to leave it on disk.
        it('deletes both directories', async () => {
            await seedSignedInDevice();
            mockExistingDirs.add('backup').add('backup-scratch');

            await wipe.wipeAllLocalUserData();

            expect(mockDeleteLog.sort()).toEqual(['backup', 'backup-scratch']);
        });

        it('deletes them BEFORE the database, so an interrupted wipe stays detectable', async () => {
            await seedSignedInDevice();
            mockExistingDirs.add('backup').add('backup-scratch');
            const factAtDelete: Promise<boolean>[] = [];
            mockOnDirDelete = () => {
                factAtDelete.push(factService.hasAnyFacts());
            };

            await wipe.wipeAllLocalUserData();

            expect(factAtDelete).toHaveLength(2);
            expect(await Promise.all(factAtDelete)).toEqual([true, true]);
            expect(await factService.hasAnyFacts()).toBe(false);
        });

        it('a failing directory delete does not stop the database wipe, and the other directory is still tried', async () => {
            await seedSignedInDevice();
            mockExistingDirs.add('backup').add('backup-scratch');
            mockOnDirDelete = (name) => {
                if (name === 'backup') throw new Error('EPERM');
            };

            await wipe.wipeAllLocalUserData();

            expect(await factService.hasAnyFacts()).toBe(false);
            expect(mockDeleteLog).toContain('backup-scratch');
        });

        it('does not try to delete a directory that is not there', async () => {
            await seedSignedInDevice();

            await wipe.wipeAllLocalUserData();

            expect(mockDeleteLog).toEqual([]);
        });
    });
});

// ---------------------------------------------------------------------------------------------
// Resuming an interrupted logout
// ---------------------------------------------------------------------------------------------

describe('purgeOrphanedLocalData', () => {
    /** The state a logout leaves when it dies between clearing the credentials and the data. */
    async function seedInterruptedLogout(): Promise<void> {
        await factService.addFact('I follow Formula 1 racing');
        await require('@/lib/security/pin-service').setPin('1234');
        await require('@/lib/security/app-lock-service').setAppLockEnabled(true);
        usePinStore.setState({ pinSet: true, lockEnabled: true });
    }

    it('wipes when user data survived the credentials, and says so', async () => {
        await seedInterruptedLogout();
        expect(await launchRoute.readLocalIdentityState()).toBe('absent');

        await expect(wipe.purgeOrphanedLocalData()).resolves.toBe(true);

        expect(await factService.hasAnyFacts()).toBe(false);
        expect(secureStoreDump()[key('pin_record')]).toBeUndefined();
        expect(secureStoreDump()[key('app_lock_enabled')]).toBeUndefined();
    });

    it('does nothing on a clean device (first install, or a logout that finished)', async () => {
        await settings.setSetting('theme_pref', 'dark');

        await expect(wipe.purgeOrphanedLocalData()).resolves.toBe(false);

        // A benign settings row does not make a signed-out device look occupied.
        expect(await settings.getSetting('theme_pref')).toBe('dark');
    });

    it('reports failure rather than throwing, so the next launch retries', async () => {
        await seedInterruptedLogout();
        track(jest.spyOn(database, 'unsafeResetDatabase')).mockRejectedValueOnce(new Error('db busy'));

        await expect(wipe.purgeOrphanedLocalData()).resolves.toBe(false);

        expect(await factService.hasAnyFacts()).toBe(true);
    });

    it('runs at most once per process: the launch effect re-fires on every session change', async () => {
        await seedInterruptedLogout();
        await expect(wipe.purgeOrphanedLocalData()).resolves.toBe(true);
        await factService.addFact('another fact');

        await expect(wipe.purgeOrphanedLocalData()).resolves.toBe(false);

        expect(await factService.hasAnyFacts()).toBe(true);
    });

    it('credentials present: the identity state reads present, which is the launch gate\'s guard against calling it', async () => {
        // The guard lives in app/index.tsx (`!hasIdentity && state === 'absent'`), not in the purge.
        await seedSignedInDevice();

        expect(await launchRoute.readLocalIdentityState()).toBe('present');
        expect(await launchRoute.hasLocalIdentity()).toBe(true);
    });

    it('finishes a logout whose erase died: keychain went first, the data stayed, the next launch completes it', async () => {
        await seedSignedInDevice();
        track(jest.spyOn(database, 'unsafeResetDatabase')).mockRejectedValueOnce(new Error('database is locked'));
        await expect(wipe.signOutAndWipe()).rejects.toThrow('database is locked');

        // Keychain before DB: every secret is gone while the DB still shows the occupant.
        const left = secrets();
        for (const k of SECURE_STORE_KEYS) expect(left[k]).toBeUndefined();
        expect(await AsyncStorage.getItem(CAPABILITY_TOKEN)).toBeNull();
        expect(await factService.hasAnyFacts()).toBe(true);
        expect(await launchRoute.readLocalIdentityState()).toBe('absent');

        // A new process: the latch is fresh, the launch gate sees 'absent' and finishes the job.
        wipe.__resetLocalWipeForTests();
        await expect(wipe.purgeOrphanedLocalData()).resolves.toBe(true);
        expect(await factService.hasAnyFacts()).toBe(false);
        expect(await wipe.hasLocalUserData()).toBe(false);
    });
});

describe('hasLocalUserData', () => {
    it('true when any user-owned table has rows', async () => {
        await factService.addFact('I follow Formula 1 racing');
        await expect(wipe.hasLocalUserData()).resolves.toBe(true);
    });

    it('false when every table is empty', async () => {
        await expect(wipe.hasLocalUserData()).resolves.toBe(false);
    });

    it('an uncountable table does not abort the sweep', async () => {
        await personaService.persistUserPersona(
            ME,
            require('@/test/mock-backend/fixtures/graphql/persona').personaFor(Date.now()),
        );
        // `facts` is the first table swept; it cannot be counted, the persona table still can.
        track(jest.spyOn(database, 'get')).mockImplementationOnce(() => {
            throw new Error('no such table');
        });

        await expect(wipe.hasLocalUserData()).resolves.toBe(true);
    });
});

// ---------------------------------------------------------------------------------------------
// Local identity: what the launch route reads
// ---------------------------------------------------------------------------------------------

describe('local identity state (what feeds the launch route)', () => {
    const resolve = (hasIdentity: boolean) =>
        launchRoute.resolveLaunchRoute({ hasIdentity, lockEnabled: false, pinSet: false, locked: false });

    it('after an explicit logout (no cached_user_id, no cookie): no identity, routed to /login', async () => {
        await seedSignedInDevice();
        await wipe.signOutAndWipe();

        const hasIdentity = await launchRoute.hasLocalIdentity();

        expect(hasIdentity).toBe(false);
        expect(resolve(hasIdentity)).toBe('/login');
    });

    it('session expiry (cached_user_id survives, cookie gone): still identified, so the app opens offline', async () => {
        await settings.setSetting('cached_user_id', ME);

        const hasIdentity = await launchRoute.hasLocalIdentity();

        expect(hasIdentity).toBe(true);
        expect(resolve(hasIdentity)).toBe('/logged-in');
    });

    it('cookie only (fresh login, id not persisted yet): identified', async () => {
        await secureStore.setItemAsync(key('cookie'), '{"better-auth.session_token":{"value":"x","expires":null}}');
        await expect(launchRoute.hasLocalIdentity()).resolves.toBe(true);
    });

    it('a throwing settings read falls through to the cookie instead of erroring', async () => {
        await secureStore.setItemAsync(key('cookie'), 'cookie-value');
        track(jest.spyOn(settings, 'getSetting')).mockRejectedValue(new Error('db unavailable'));

        await expect(launchRoute.hasLocalIdentity()).resolves.toBe(true);
    });

    // `absent` authorises destroying every byte of local user data, so it must mean "both reads
    // completed and found nothing", never "a read failed".
    it('both reads complete and find nothing: absent, the only wipe-authorising state', async () => {
        await expect(launchRoute.readLocalIdentityState()).resolves.toBe('absent');
    });

    it('cached id present: present', async () => {
        await settings.setSetting('cached_user_id', ME);
        await expect(launchRoute.readLocalIdentityState()).resolves.toBe('present');
    });

    it('cookie present: present', async () => {
        await secureStore.setItemAsync(key('cookie'), 'cookie-value');
        await expect(launchRoute.readLocalIdentityState()).resolves.toBe('present');
    });

    it('keychain read THROWS and nothing else found: unknown, never absent', async () => {
        failSecureStore(key('cookie'), 'get');
        await expect(launchRoute.readLocalIdentityState()).resolves.toBe('unknown');
    });

    it('settings read THROWS and nothing else found: unknown, never absent', async () => {
        track(jest.spyOn(settings, 'getSetting')).mockRejectedValue(new Error('db unavailable'));
        await expect(launchRoute.readLocalIdentityState()).resolves.toBe('unknown');
    });

    it('unknown still routes to /login: recoverable by signing in, unlike a wipe', async () => {
        track(jest.spyOn(settings, 'getSetting')).mockRejectedValue(new Error('db unavailable'));

        const state = await launchRoute.readLocalIdentityState();

        expect(state).toBe('unknown');
        expect(await launchRoute.hasLocalIdentity()).toBe(false);
        expect(resolve(false)).toBe('/login');
    });
});

// ---------------------------------------------------------------------------------------------
// B1: deleting the account
// ---------------------------------------------------------------------------------------------

describe('delete account (useDeleteAccount)', () => {
    const mount = () => renderHook(() => useDeleteAccount());
    const deleteAccount = (hook: ReturnType<typeof mount>) => runConfirming(() => hook.result.current(), 2);

    async function deleteWithEverythingSeeded() {
        await seedSignedInDevice();
        await secureStore.setItemAsync(key('device_ref'), 'retired');
        await deleteAccount(mount());
    }

    it('asks twice, requests the deletion, signs out, severs the device binding and clears the stores', async () => {
        const requests: string[] = [];
        const listener = ({ request }: { request: Request }) => {
            if (request.url.endsWith('/request-account-deletion')) requests.push(request.method);
        };
        server.events.on('request:start', listener);
        try {
            await deleteWithEverythingSeeded();
        } finally {
            server.events.removeListener('request:start', listener);
        }

        expect(requests).toEqual(['POST']);
        // What deletion already does right.
        expect(secureStoreDump()[key('cookie')]).toBeUndefined();
        for (const credential of [...DEVICE_CREDENTIALS, key('device_ref')]) {
            expect(secureStoreDump()[credential]).toBeUndefined();
        }
        expect(replaced()).toEqual([[LOGIN_SIGNED_OUT]]);
        expect(await factService.hasAnyFacts()).toBe(false);
        expect(await settings.getSetting('cached_user_id')).toBeNull();
        expect(Purchases.logOut).toHaveBeenCalled();
        expect(Intercom.logout).toHaveBeenCalled();
    });

    it('disconnects Google Drive', async () => {
        await deleteWithEverythingSeeded();

        expect(GoogleSignin.signOut).toHaveBeenCalled();
    });

    it('with no Drive connected, never signs Google out and still deletes', async () => {
        driveConnected(false);

        await deleteWithEverythingSeeded();

        expect(GoogleSignin.hasPreviousSignIn).toHaveBeenCalled();
        expect(GoogleSignin.signOut).not.toHaveBeenCalled();
        expect(secureStoreDump()[key('cookie')]).toBeUndefined();
        expect(replaced()).toEqual([[LOGIN_SIGNED_OUT]]);
    });

    it('cancelling at either confirmation changes nothing and sends nothing', async () => {
        await seedSignedInDevice();
        const { result } = mount();
        let requested = false;
        const listener = ({ request }: { request: Request }) => {
            if (request.url.endsWith('/request-account-deletion')) requested = true;
        };
        server.events.on('request:start', listener);

        const done = result.current();
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        act(() => settleDialog(useDialogQueue.getState().queue[0].id, true));
        await waitFor(() => expect(useDialogQueue.getState().queue).toHaveLength(1));
        act(() => settleDialog(useDialogQueue.getState().queue[0].id, false));
        await done;
        server.events.removeListener('request:start', listener);

        expect(requested).toBe(false);
        expect(secureStoreDump()[key('cookie')]).toBeDefined();
        expect(await factService.hasAnyFacts()).toBe(true);
        expect(replaced()).toEqual([]);
    });

    it('a deletion the server refuses changes nothing local', async () => {
        server.use(
            http.post('*/api/auth/request-account-deletion', () =>
                HttpResponse.json({ code: 'SERVER_ERROR', message: 'boom' }, { status: 500 }),
            ),
        );
        await seedSignedInDevice();

        await deleteAccount(mount());

        expect(secureStoreDump()[key('cookie')]).toBeDefined();
        expect(secureStoreDump()[DEVICE_CREDENTIALS[0]]).toBeDefined();
        expect(await factService.hasAnyFacts()).toBe(true);
        expect(await settings.getSetting('cached_user_id')).toBe(ME);
        expect(replaced()).toEqual([]);
    });

    test.failing('B1 deleting the account removes every local secret', async () => {
        await deleteWithEverythingSeeded();

        const left = secrets();
        for (const k of SECURE_STORE_KEYS) expect(left[k]).toBeUndefined();
        expect(await AsyncStorage.getItem(CAPABILITY_TOKEN)).toBeNull();
    });

    test('B1 today: the PIN record, app-lock flag, backup key and both E2EE private keys survive account deletion', async () => {
        await deleteWithEverythingSeeded();

        // Only the session, the device credentials and the stores go: every other secret is still here.
        expect(Object.keys(secrets()).sort()).toEqual(
            [
                key('pin_record'),
                key('pin_attempts'),
                key('app_lock_enabled'),
                key('pin_force_reset_v1'),
                key('backup_key'),
                'async_pipeline_privkey',
                'async_inference_pending_job_privkey',
            ].sort(),
        );
        expect(secureStoreDump()[key('app_lock_enabled')]).toBe('1');
        expect(await AsyncStorage.getItem(CAPABILITY_TOKEN)).toBe('capability');
    });
});

// ---------------------------------------------------------------------------------------------
// B2: the onboarding server-error logout
// ---------------------------------------------------------------------------------------------

describe('onboarding server-error logout (useServerErrorLogout)', () => {
    async function logOutFromOnboarding() {
        await signIn();
        await settings.setSetting('cached_user_id', ME);
        useUserStore.setState({ userId: ME });
        const setShow = jest.fn();
        const { result } = renderHook(() => useServerErrorLogout(setShow));
        await act(async () => {
            await result.current.handleServerErrorLogout();
        });
        return { setShow, result };
    }

    it('hides the error, signs the session out, resets the SDKs and goes back to the launch gate', async () => {
        const { setShow, result } = await logOutFromOnboarding();

        expect(setShow).toHaveBeenCalledWith(false);
        expect(secureStoreDump()[key('cookie')]).toBeUndefined();
        expect(Purchases.logOut).toHaveBeenCalled();
        expect(Intercom.logout).toHaveBeenCalled();
        expect(replaced()).toEqual([['/']]);
        expect(result.current.isLoggingOut).toBe(false);
    });

    test.failing('B2 the onboarding logout leaves the device signed out', async () => {
        await logOutFromOnboarding();

        expect(await settings.getSetting('cached_user_id')).toBeNull();
        const hasIdentity = (await launchRoute.readLocalIdentityState()) === 'present';
        expect(
            launchRoute.resolveLaunchRoute({ hasIdentity, lockEnabled: false, pinSet: false, locked: false }),
        ).toBe('/login');
    });

    test('B2 today: the identity stamp survives, so the launch gate routes straight back into the app', async () => {
        await logOutFromOnboarding();

        expect(await settings.getSetting('cached_user_id')).toBe(ME);
        const hasIdentity = (await launchRoute.readLocalIdentityState()) === 'present';
        expect(
            launchRoute.resolveLaunchRoute({ hasIdentity, lockEnabled: false, pinSet: false, locked: false }),
        ).toBe('/logged-in');
    });
});
