// The launch gate (useLoggedInGate) and the identity modules under it, at their seams: the real
// stores, the in-memory DB, the real auth client against the mock backend, the real keychain
// fake. Only the native edges are faked. The pure identity-gate cases and the install boundary
// ride in this file because they decide what the gate does.
import Intercom from '@intercom/intercom-react-native';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as Sentry from '@sentry/react-native';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { TurboModuleRegistry } from 'react-native';
import Purchases from 'react-native-purchases';
import {
    useLoggedInGate,
    __resetLoggedInGateForTests,
} from '@/components/custom/auth/useLoggedInGate';
import { __resetLegalConsentLatchForTests } from '@/components/custom/auth/legal-consent';
import { markOnboardingDone } from '@/components/custom/onboarding/onboarding-done';
import { _resetForTests as resetAuthBreaker } from '@/lib/auth-failure-breaker';
import { authClient } from '@/lib/auth-client';
import database from '@/lib/database';
import { addFact, hasAnyFacts } from '@/lib/database/services/fact-service';
import * as settingService from '@/lib/database/services/setting-service';
import { deleteSetting, getSetting, setSetting } from '@/lib/database/services/setting-service';
import { persistUserPersona } from '@/lib/database/services/user-persona-service';
import { ensureBackupKey } from '@/lib/backup/key-store';
import * as endpoints from '@/lib/config/endpoints';
import { configureIntercom, isIntercomEnabled } from '@/lib/intercom';
import { configureRevenueCat } from '@/lib/revenuecat';
import { setAppLockEnabled } from '@/lib/security/app-lock-service';
import {
    IDENTITY_FAULT_KEY,
    __resetIdentityStateForTests,
    clearIdentityFault,
    clearPendingAuthUserId,
    effectiveSessionUserId,
    hasIdentityFault,
    holdAccountSwitch,
    isAccountSwitchHeld,
    isIdentitySwitchBlocked,
    isOwnershipFault,
    readPendingAuthUserId,
    recordAuthenticatedUser,
    recordOwnershipFault,
    releaseAccountSwitch,
    resolveIdentity,
    setIdentitySwitchBlocked,
} from '@/lib/security/identity-gate';
import {
    HAS_LAUNCHED_SETTING_KEY,
    __resetInstallBoundaryForTests,
    enforceInstallBoundary,
    wasInstallBoundaryReset,
} from '@/lib/security/install-boundary';
import {
    __resetAuthReadQuarantineForTests,
    isAuthReadQuarantined,
} from '@/lib/security/install-boundary-latch';
import { setPin } from '@/lib/security/pin-service';
import { STARTUP_TAB_DEFAULT } from '@/lib/navigation/startup-tab';
import { usePinStore } from '@/lib/stores/pin-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import {
    FIXTURE_ACCOUNT,
    HttpResponse,
    failSecureStore,
    http,
    secureStoreDump,
    server,
    signInFixtureAccount,
} from '@/test/helpers';
import { personaFor } from '@/test/mock-backend/fixtures/graphql/persona';
import { RESTORE_CAP_MS } from '@/components/custom/auth/useLoggedInGate';
import { __resetAppRestartForTests, autoReloadDisabled, RESTART_MARKER_KEY } from '@/lib/app-restart';
import * as resumeSpot from '@/lib/navigation/resume-spot';
import * as otaNotice from '@/lib/ota-notice';
import logger from '@/lib/logger';
import { __resetSplashHoldForTests, restoreLookState } from '@/lib/splash-hold';
import {
    __resetPendingNotificationRouteForTests,
    stashPendingNotificationRoute,
} from '@/lib/stores/pending-notification-route';

const ME = FIXTURE_ACCOUNT.userId;
const FOREIGN = '66e2e0000000000000000002';
const SLUG = Constants.expoConfig?.slug || 'app';
const key = (suffix: string) => `${SLUG}_${suffix}`;
const APP_ROUTE = `/logged-in/app_container/${STARTUP_TAB_DEFAULT}`;
const REAUTH = { pathname: '/login', params: { reauth: '1' } };

const replaceMock = () => jest.mocked(router.replace);
const replaced = () => replaceMock().mock.calls;

// ---------------------------------------------------------------------------------------------
// Determinism. Three things outlive a test and would leak into the next one:
//  - better-auth's session atom is module state, and after the first mount it never refetches
//    (its signal subscription is dropped on unmount), so it is set to the truth before each mount;
//  - fire-and-forget work (persona fetch and persist, entitlement sync, RevenueCat login, the
//    parallel session recheck) is drained by counting requests in flight;
//  - module memory in the app code is reset through its own test hooks.
// ---------------------------------------------------------------------------------------------

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
    (authClient as unknown as { $store: { atoms: { session: { get(): any; set(v: unknown): void } } } })
        .$store.atoms.session;

/** What the atom would hold after a refetch against the mock server. */
async function syncSessionAtom(): Promise<void> {
    const { data } = await authClient.getSession();
    sessionAtom().set({ ...sessionAtom().get(), data, error: null, isPending: false, isRefetching: false });
}

async function signIn(): Promise<void> {
    await signInFixtureAccount();
    await syncSessionAtom();
}

const spies: jest.SpyInstance[] = [];
const track = <T extends jest.SpyInstance>(spy: T): T => {
    spies.push(spy);
    return spy;
};

// Intercom and Google Drive read their keys from lib/config/endpoints, which is fixed when it first
// loads (before this file runs), and the account-switch wipe logs out of both (invariant 4b). Each is a
// no-op when unconfigured, so the keys are set on the live bindings the two modules read at call time.
const sdkKeys: jest.ReplaceProperty<unknown>[] = [];
let registrySpy: jest.SpyInstance;
beforeAll(async () => {
    sdkKeys.push(
        jest.replaceProperty(endpoints, 'INTERCOM_APP_ID', 'test_intercom_app'),
        jest.replaceProperty(endpoints, 'INTERCOM_IOS_KEY', 'test_intercom_ios_key'),
        jest.replaceProperty(endpoints, 'GOOGLE_WEB_CLIENT_ID', 'test_google_web_client_id'),
    );
    // google-drive.ts caches its "is the native module linked" probe on first use, so the link must
    // be in place before any test reaches it. Only RNGoogleSignin is answered.
    const realGet = TurboModuleRegistry.get.bind(TurboModuleRegistry);
    registrySpy = jest
        .spyOn(TurboModuleRegistry, 'get')
        .mockImplementation(((name: string) => (name === 'RNGoogleSignin' ? {} : realGet(name))) as never);
    server.events.on('request:start', onStart);
    server.events.on('request:end', onEnd);
    configureRevenueCat();
    // Guard: with the env set too late Intercom would never configure and its assertion would be vacuous.
    expect(isIntercomEnabled()).toBe(true);
    expect(await configureIntercom()).toBe(true);
});

afterAll(() => {
    registrySpy.mockRestore();
    for (const key of sdkKeys) key.restore();
    server.events.removeListener('request:start', onStart);
    server.events.removeListener('request:end', onEnd);
});

beforeEach(() => {
    inFlight = 0;
    __resetIdentityStateForTests();
    __resetLoggedInGateForTests();
    __resetLegalConsentLatchForTests();
    __resetInstallBoundaryForTests();
    __resetAuthReadQuarantineForTests();
    resetAuthBreaker();
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
    useNetworkStore.setState({ isConnected: true, serverReachable: true, serverSlow: false, internetReachable: true });
    sessionAtom().set({ ...sessionAtom().get(), data: null, error: null, isPending: false, isRefetching: false });
});

afterEach(async () => {
    cleanup();
    jest.useRealTimers();
    await drain();
    jest.mocked(GoogleSignin.hasPreviousSignIn).mockReturnValue(false);
    while (spies.length) spies.pop()?.mockRestore();
});

// ---------------------------------------------------------------------------------------------
// Seeds, all through the app's own services.
// ---------------------------------------------------------------------------------------------

async function seedPinLock(): Promise<void> {
    await setPin('1234');
    await setAppLockEnabled(true);
    usePinStore.setState({ pinSet: true, lockEnabled: true });
}

async function seedBackupKeyAndE2eeKeys(): Promise<void> {
    await ensureBackupKey();
    await secureStore.setItemAsync('async_pipeline_privkey', 'pipeline-key');
}

const mountGate = () => renderHook(() => useLoggedInGate());
const waitForRoute = () => waitFor(() => expect(replaced().length).toBeGreaterThan(0), { timeout: 8000 });

describe('useLoggedInGate: fresh sign-in', () => {
    it('stamps cached_user_id with the signed-in id, adopts it in the user store and goes to the wizard', async () => {
        await signIn();

        mountGate();
        await waitForRoute();
        await drain();

        expect(replaced()).toEqual([['/logged-in/onboarding']]);
        expect(await getSetting('cached_user_id')).toBe(ME);
        expect(useUserStore.getState().userId).toBe(ME);
        // The warmup fires the RevenueCat login that a later purchase hangs on.
        expect(Purchases.logIn).toHaveBeenCalledWith(ME);
    });
});

/** Every URL the app requests from now on (until the test ends). */
function recordUrls(): string[] {
    const urls: string[] = [];
    const listener = ({ request }: { request: Request }) => {
        urls.push(request.url);
    };
    server.events.on('request:start', listener);
    const stop = () => server.events.removeListener('request:start', listener);
    afterEachStops.push(stop);
    return urls;
}
const afterEachStops: (() => void)[] = [];
afterEach(() => {
    while (afterEachStops.length) afterEachStops.pop()?.();
});

describe('useLoggedInGate: where a signed-in launch goes', () => {
    it('an onboarded account opens on the startup tab', async () => {
        await signIn();
        await setSetting('cached_user_id', ME);
        await markOnboardingDone();

        mountGate();
        await waitForRoute();
        await drain();

        expect(replaced()).toEqual([[APP_ROUTE]]);
        expect(useUserStore.getState().userId).toBe(ME);
    });

    it('opens on the tab the person chose, not the default', async () => {
        await signIn();
        await setSetting('cached_user_id', ME);
        await markOnboardingDone();
        await setSetting('startup_tab', 'world');

        mountGate();
        await waitForRoute();
        await drain();

        expect(replaced()).toEqual([['/logged-in/app_container/world']]);
    });

    it('a device with facts but no onboarding_done row counts as done, and the row is written (invariant 1)', async () => {
        await signIn();
        await setSetting('cached_user_id', ME);
        await addFact('I follow Formula 1 racing');
        expect(await getSetting('onboarding_done')).toBeNull();

        mountGate();
        await waitForRoute();
        await drain();

        expect(replaced()).toEqual([[APP_ROUTE]]);
        expect(await getSetting('onboarding_done')).toBe('true');
    });

    it('a returning account that never finished onboarding goes back to the wizard', async () => {
        await signIn();
        await setSetting('cached_user_id', ME);

        mountGate();
        await waitForRoute();
        await drain();

        expect(replaced()).toEqual([['/logged-in/onboarding']]);
        expect(await getSetting('onboarding_done')).toBeNull();
    });

    it('no identity at all goes back to the launch gate', async () => {
        mountGate();
        await waitForRoute();
        await drain();

        expect(replaced()).toEqual([['/']]);
        expect(router.dismissAll).toHaveBeenCalled();
        expect(await getSetting('cached_user_id')).toBeNull();
    });
});

// The spot an update reload carried (lib/app-restart.ts marker) is rebuilt by the feed's
// restoreSpot, faked here at its seam: the gate's contract is the call order, the cap, the
// single use and the fallback. restoreSpot itself is tested by the feed.
describe('useLoggedInGate: an update reload puts the reader back', () => {
    const SPOT = { v: 1, tab: 'feed', page: null, tabStack: [], rootStack: [] };
    const seedReload = (reason: string, spot: unknown = SPOT) =>
        setSetting(RESTART_MARKER_KEY, JSON.stringify({ reason, at: 1, backgroundedAt: null, lastForegroundAt: null, spot }));
    const seedOnboarded = async () => {
        await signIn();
        await setSetting('cached_user_id', ME);
        await markOnboardingDone();
    };
    let restore: jest.SpyInstance;
    let announce: jest.SpyInstance;

    beforeEach(() => {
        __resetAppRestartForTests();
        __resetSplashHoldForTests();
        __resetPendingNotificationRouteForTests();
        restore = jest.spyOn(resumeSpot, 'restoreSpot').mockResolvedValue('restored');
        announce = jest.spyOn(otaNotice, 'announceAppliedUpdate').mockResolvedValue();
        spies.push(restore, announce);
    }, 30_000);

    it('rebuilds the spot after the gates INSTEAD of the startup tab, then announces once', async () => {
        await seedOnboarded();
        await seedReload('ota');

        mountGate();
        await waitFor(() => expect(announce).toHaveBeenCalled(), { timeout: 8000 });
        await drain();

        expect(restore).toHaveBeenCalledTimes(1);
        expect(restore.mock.calls[0][0]).toEqual(SPOT);
        expect(replaced()).toEqual([]);
        expect(announce).toHaveBeenCalledWith(undefined);
        expect(autoReloadDisabled()).toBe(false);
        expect(restoreLookState()).toBe('done');
    }, 30_000);

    it('the gate running twice rebuilds once; the second run takes the startup tab', async () => {
        await seedOnboarded();
        await seedReload('update');

        const first = mountGate();
        await waitFor(() => expect(announce).toHaveBeenCalledTimes(1), { timeout: 8000 });
        first.unmount();
        // The gate mounts again (a PIN unlock, a reauth): it must not rebuild or announce again.
        mountGate();
        await waitForRoute();
        await drain();

        expect(restore).toHaveBeenCalledTimes(1);
        expect(replaced()).toEqual([[APP_ROUTE]]);
    }, 30_000);

    it('a cold launch never rebuilds', async () => {
        await seedOnboarded();

        mountGate();
        await waitForRoute();
        await drain();

        expect(restore).not.toHaveBeenCalled();
        expect(replaced()).toEqual([[APP_ROUTE]]);
    }, 30_000);

    it('a language restart carries no spot, so it never rebuilds', async () => {
        await seedOnboarded();
        await seedReload('language');

        mountGate();
        await waitForRoute();
        await drain();

        expect(restore).not.toHaveBeenCalled();
    }, 30_000);

    it('a failed rebuild lands on the startup tab and switches automatic reloads off', async () => {
        await seedOnboarded();
        await seedReload('ota');
        restore.mockResolvedValue('failed');

        mountGate();
        await waitForRoute();
        await drain();

        expect(replaced()).toEqual([[APP_ROUTE]]);
        expect(autoReloadDisabled()).toBe(true);
        expect(restoreLookState()).toBe('done');
    }, 30_000);

    it('a rebuild that throws counts as failed', async () => {
        await seedOnboarded();
        await seedReload('ota');
        restore.mockRejectedValue(new Error('nav not ready'));
        spies.push(jest.spyOn(logger, 'captureException').mockImplementation(() => ''));

        mountGate();
        await waitForRoute();
        await drain();

        expect(replaced()).toEqual([[APP_ROUTE]]);
        expect(autoReloadDisabled()).toBe(true);
    }, 30_000);

    it('a rebuild past the cap is aborted, so a late finish pushes nothing, and the startup tab wins', async () => {
        await seedOnboarded();
        await seedReload('ota');
        let signal: AbortSignal | undefined;
        restore.mockImplementation((_spot: unknown, opts?: { signal?: AbortSignal }) => {
            signal = opts?.signal;
            return new Promise(() => {});
        });

        mountGate();
        await waitFor(() => expect(replaced()).toEqual([[APP_ROUTE]]), { timeout: 8000 + RESTORE_CAP_MS });
        await drain();

        expect(signal?.aborted).toBe(true);
        expect(autoReloadDisabled()).toBe(true);
    }, 30_000);

    it('a restored story that is gone is announced as gone', async () => {
        await seedOnboarded();
        await seedReload('ota');
        spies.push(jest.spyOn(resumeSpot, 'lastRestoreMissing').mockReturnValue('story'));

        mountGate();
        await waitFor(() => expect(announce).toHaveBeenCalled(), { timeout: 8000 });

        expect(announce).toHaveBeenCalledWith('story');
    }, 30_000);

    it('a notification tap that arrives during the rebuild opens on top of it afterwards and does not fail it', async () => {
        await seedOnboarded();
        await seedReload('ota');
        const tap = { pathname: '/logged-in/article-detail', params: { articleId: 'a-1' } } as const;
        restore.mockImplementation(async () => {
            await stashPendingNotificationRoute(tap, ME);
            return 'restored';
        });

        mountGate();
        await waitFor(() => expect(router.push).toHaveBeenCalledWith(tap), { timeout: 8000 });
        await drain();

        expect(replaced()).toEqual([]);
        expect(autoReloadDisabled()).toBe(false);
    }, 30_000);
});

describe('useLoggedInGate: account switch', () => {
    it('wipes the previous account, keeps the incoming session and stamps the new id', async () => {
        await signIn();
        await setSetting('cached_user_id', FOREIGN);
        await addFact('I follow cricket');
        await seedPinLock();
        await seedBackupKeyAndE2eeKeys();
        // Positive controls: the secrets are really there before the gate runs.
        const before = secureStoreDump();
        expect(before[key('pin_record')]).toBeDefined();
        expect(before[key('app_lock_enabled')]).toBe('1');
        expect(before[key('backup_key')]).toBeDefined();
        expect(await hasAnyFacts()).toBe(true);

        mountGate();
        await waitForRoute();
        await drain();

        expect(await hasAnyFacts()).toBe(false);
        const dump = secureStoreDump();
        for (const gone of ['pin_record', 'pin_attempts', 'app_lock_enabled', 'backup_key']) {
            expect(dump[key(gone)]).toBeUndefined();
        }
        expect(dump.async_pipeline_privkey).toBeUndefined();
        // The incoming account's own session survives, and the next launch reads it as the same install.
        expect(dump[key('cookie')]).toBeDefined();
        expect(await getSetting(HAS_LAUNCHED_SETTING_KEY)).toBe('1');
        expect(await getSetting('cached_user_id')).toBe(ME);
        expect(useUserStore.getState().userId).toBe(ME);
        expect(usePinStore.getState()).toMatchObject({ pinSet: false, lockEnabled: false, locked: false });
        // The billing SDK goes back to anonymous so the new account cannot inherit the old plan.
        expect(Purchases.logOut).toHaveBeenCalled();
        expect(replaced()).toEqual([['/logged-in/onboarding']]);
    });

    // Invariant 4b: the switch wipe signs both SDKs out, or the next account inherits a stranger's
    // support conversation and a connected Drive that its backup would upload into.
    it('logs the previous account out of Intercom and disconnects Google Drive', async () => {
        await signIn();
        await setSetting('cached_user_id', FOREIGN);
        await addFact('I follow cricket');
        jest.mocked(GoogleSignin.hasPreviousSignIn).mockReturnValue(true);

        mountGate();
        await waitForRoute();
        await drain();

        expect(await hasAnyFacts()).toBe(false);
        expect(Intercom.logout).toHaveBeenCalled();
        expect(GoogleSignin.signOut).toHaveBeenCalled();
    });

    it('a wipe that throws fails closed (blocking state, foreign stamp kept, no route); Try again wipes and routes', async () => {
        await signIn();
        await setSetting('cached_user_id', FOREIGN);
        await addFact('I follow cricket');
        track(jest.spyOn(database, 'unsafeResetDatabase')).mockRejectedValueOnce(new Error('db busy'));

        const hook = mountGate();
        await waitFor(() => expect(hook.result.current.wipeFailed).toBe(true), { timeout: 8000 });
        await drain();

        expect(replaced()).toEqual([]);
        // The unchanged stamp IS the retry marker; the previous owner's data is still there.
        expect(await getSetting('cached_user_id')).toBe(FOREIGN);
        expect(await hasAnyFacts()).toBe(true);

        act(() => hook.result.current.handleRetry());
        await waitForRoute();
        await drain();

        expect(hook.result.current.wipeFailed).toBe(false);
        expect(await hasAnyFacts()).toBe(false);
        expect(await getSetting('cached_user_id')).toBe(ME);
        expect(replaced()).toEqual([['/logged-in/onboarding']]);
    });

    it.each([
        ['resolves without writing', async () => undefined],
        [
            'rejects',
            async () => {
                throw new Error('disk full');
            },
        ],
    ])('a stamp that does not land (the write %s) fails closed; Try again stamps and routes', async (_name, fake) => {
        await signIn();
        await setSetting('cached_user_id', FOREIGN);
        await addFact('I follow cricket');
        const real = settingService.setSetting;
        track(jest.spyOn(settingService, 'setSetting')).mockImplementation((k, v) =>
            k === 'cached_user_id' && v === ME ? fake() : real(k, v),
        );

        const hook = mountGate();
        await waitFor(() => expect(hook.result.current.wipeFailed).toBe(true), { timeout: 8000 });
        await drain();

        expect(replaced()).toEqual([]);
        expect(await getSetting('cached_user_id')).toBeNull();
        expect(useUserStore.getState().userId).toBeNull();

        spies.pop()?.mockRestore();
        act(() => hook.result.current.handleRetry());
        await waitForRoute();
        await drain();

        expect(await getSetting('cached_user_id')).toBe(ME);
        expect(replaced()).toEqual([['/logged-in/onboarding']]);
    });

    it('before the session atom settles, the recorded sign-in still triggers the wipe and the stamp (invariant 6b)', async () => {
        // No cookie and an empty atom: only the in-process recording knows who signed in.
        await setSetting('cached_user_id', FOREIGN);
        await addFact('I follow cricket');
        recordAuthenticatedUser(ME);

        mountGate();
        await waitForRoute();
        await drain();

        expect(await hasAnyFacts()).toBe(false);
        expect(await getSetting('cached_user_id')).toBe(ME);
        expect(useUserStore.getState().userId).toBe(ME);
        // Consumed once it is on disk.
        expect(readPendingAuthUserId()).toBeNull();
        expect(replaced()).toEqual([['/logged-in/onboarding']]);
    });

    // PE25: a held id is unresolved, so the gate opens the CACHED account and routes into the app while
    // the person is still being asked about the switch on /login, with the held account's cookie in the
    // keychain.
    describe('PE25 a held account switch', () => {
        /** Operation names of every GraphQL request from now on. */
        function recordOps(): string[] {
            const ops: string[] = [];
            const listener = ({ request }: { request: Request }) => {
                if (!request.url.endsWith('/graphql')) return;
                void request
                    .clone()
                    .json()
                    .then((b: { operationName?: string }) => {
                        if (b.operationName) ops.push(b.operationName);
                    });
            };
            server.events.on('request:start', listener);
            afterEachStops.push(() => server.events.removeListener('request:start', listener));
            return ops;
        }

        /** The held switch over a device that holds another, onboarded account. */
        async function mountHeld(): Promise<string[]> {
            await signIn();
            await setSetting('cached_user_id', FOREIGN);
            await addFact('I follow cricket');
            holdAccountSwitch(ME);
            const ops = recordOps();

            mountGate();
            // A correct gate does nothing here, so there is nothing to wait for: settle, then look.
            await drain();
            await new Promise((r) => setTimeout(r, 300));
            await drain();
            return ops;
        }

        test('PE25 a held account switch neither routes nor fetches as the cached account', async () => {
            const ops = await mountHeld();

            expect(replaced()).toEqual([]);
            expect(ops.filter((op) => op === 'GetUserPersona')).toEqual([]);
        });
    });

    // U4-N1: the gate's persona second opinion ("a row owned by somebody else proves the device is
    // contaminated even when the sentinel says otherwise") upgrades a coherent verdict to
    // wipeAndProceed, but the wipe it then runs is lib/stores/index.ts clearPreviousUserData, which
    // acts only when cached_user_id is set AND different from the incoming id. Here it matches, so
    // the upgrade wiped nothing: the incoming account was routed in on the other owner's facts and
    // skipped onboarding. The gate now forces a full wipe on that evidence (forceWipeOnce).
    describe('persona row owned by another account, sentinel matching the incoming one', () => {
        async function seed() {
            await signIn();
            await setSetting('cached_user_id', ME);
            await addFact('I follow cricket');
            await persistUserPersona(FOREIGN, personaFor(Date.now(), { userId: FOREIGN }));
        }

        test('U4-N1 the previous owner facts are wiped before the incoming account is routed in', async () => {
            await seed();

            mountGate();
            await waitForRoute();
            await drain();

            expect(await hasAnyFacts()).toBe(false);
            expect(replaced()).toEqual([['/logged-in/onboarding']]);
        });
    });

    // PE9b, the same dead wipe with NO stamp: resolveIdentity answers wipeAndProceed outright (no
    // cached_user_id), so the persona second opinion is never asked, and clearPreviousUserData does
    // nothing without a stamp to compare. A persona row owned by another account is the positive
    // evidence the gate exists to act on; without it (facts alone) not wiping is intended.
    describe('persona row owned by another account, no stamp at all', () => {
        async function seed() {
            await signIn();
            await addFact('I follow cricket');
            await persistUserPersona(FOREIGN, personaFor(Date.now(), { userId: FOREIGN }));
            expect(await getSetting('cached_user_id')).toBeNull();
            jest.mocked(Sentry.captureMessage).mockClear();
        }

        test('PE9b the previous owner facts are wiped before the incoming account is routed in', async () => {
            await seed();

            mountGate();
            await waitForRoute();
            await drain();

            expect(await hasAnyFacts()).toBe(false);
            expect(replaced()).toEqual([['/logged-in/onboarding']]);
        });
    });
});

describe('useLoggedInGate: ownership fault and the account check', () => {
    it('an ownership fault, online, with the auth server answering, sends the person to sign in again', async () => {
        const urls = recordUrls();
        await signIn();
        await setSetting('cached_user_id', ME);
        await markOnboardingDone();
        await addFact('I follow Formula 1 racing');
        await setSetting(IDENTITY_FAULT_KEY, '1');

        mountGate();
        await waitForRoute();
        await drain();

        expect(urls.some((u) => u.endsWith('/api/auth/ok'))).toBe(true);
        expect(replaced()).toEqual([[REAUTH]]);
        // Reauth is the server's verdict on a pairing the device cannot fix locally: it never wipes.
        expect(await hasAnyFacts()).toBe(true);
        expect(await getSetting('cached_user_id')).toBe(ME);
    });

    it('the same fault with the auth server down is deferred: no eject, and the fault stays persisted for the next launch', async () => {
        server.use(http.get('*/api/auth/ok', () => new HttpResponse(null, { status: 503 })));
        await signIn();
        await setSetting('cached_user_id', ME);
        await markOnboardingDone();
        await setSetting(IDENTITY_FAULT_KEY, '1');

        mountGate();
        await waitForRoute();
        await drain();

        expect(replaced()).toEqual([[APP_ROUTE]]);
        // Only a fresh proof of identity clears it, never a gate that merely chose not to eject.
        expect(await getSetting(IDENTITY_FAULT_KEY)).toBe('1');
    });

    it('offline with a coherent local identity: adopts the id in memory, writes nothing, shows the offline gate', async () => {
        useNetworkStore.setState({ isConnected: false });
        await setSetting('cached_user_id', ME);
        const writes: string[] = [];
        const real = settingService.setSetting;
        track(jest.spyOn(settingService, 'setSetting')).mockImplementation((k, v) => {
            writes.push(k);
            return real(k, v);
        });

        const hook = mountGate();
        await waitFor(() => expect(hook.result.current.gate).toBe('offline'), { timeout: 8000 });
        await drain();

        expect(await getSetting('cached_user_id')).toBe(ME);
        expect(writes.filter((k) => k === 'cached_user_id' || k === HAS_LAUNCHED_SETTING_KEY)).toEqual([]);
        expect(useUserStore.getState().userId).toBe(ME);
        expect(replaced()).toEqual([]);
    });

    describe('the launch account check', () => {
        const recheckOnly = (reply: () => Response) =>
            http.get('*/api/auth/get-session', ({ request }) =>
                new URL(request.url).searchParams.has('disableCookieCache') ? reply() : undefined,
            );

        it('a dead session at launch routes to sign in with reauth', async () => {
            await signIn();
            await setSetting('cached_user_id', ME);
            await markOnboardingDone();
            server.use(recheckOnly(() => HttpResponse.json(null)));

            mountGate();
            await waitForRoute();
            await drain();

            expect(replaced()).toEqual([[REAUTH]]);
        });

        it('a dead session routes to sign in even when the check answers after the local reads', async () => {
            // The board's start screen stays up while the check runs: a slow answer still gates.
            await signIn();
            await setSetting('cached_user_id', ME);
            await markOnboardingDone();
            server.use(
                http.get('*/api/auth/get-session', async ({ request }) => {
                    if (!new URL(request.url).searchParams.has('disableCookieCache')) return undefined;
                    await new Promise((resolve) => setTimeout(resolve, 400));
                    return HttpResponse.json(null);
                }),
            );

            mountGate();
            await waitForRoute();
            await drain();

            expect(replaced()).toEqual([[REAUTH]]);
        });

        it('Mera down at a cold start shows the unreachable gate, not an app whose queries fail', async () => {
            await signIn();
            await setSetting('cached_user_id', ME);
            await markOnboardingDone();
            server.use(
                recheckOnly(() => HttpResponse.json({ message: 'boom' }, { status: 500 })),
                http.get('*/api/auth/ok', () => new HttpResponse(null, { status: 503 })),
                http.get('*/generate_204', () => new HttpResponse(null, { status: 204 })),
                http.get('*/hotspot-detect.html', () => HttpResponse.text('Success')),
            );

            const hook = mountGate();
            await waitFor(() => expect(hook.result.current.gate).toBe('unreachable'), { timeout: 8000 });
            await drain();

            expect(replaced()).toEqual([]);
        });

        it('a link with no internet behind it (captive portal) is offline, never blamed on Mera', async () => {
            await signIn();
            await setSetting('cached_user_id', ME);
            await markOnboardingDone();
            server.use(
                recheckOnly(() => HttpResponse.error()),
                http.get('*/api/auth/ok', () => HttpResponse.error()),
                http.get('*/generate_204', () => HttpResponse.text('portal login', { status: 200 })),
                http.get('*/hotspot-detect.html', () => HttpResponse.text('portal login', { status: 200 })),
            );

            const hook = mountGate();
            await waitFor(() => expect(hook.result.current.gate).toBe('offline'), { timeout: 8000 });
            await drain();

            expect(replaced()).toEqual([]);
        });

        it('a live session opens the app (the control for the two cases above)', async () => {
            await signIn();
            await setSetting('cached_user_id', ME);
            await markOnboardingDone();

            mountGate();
            await waitForRoute();
            await drain();

            expect(replaced()).toEqual([[APP_ROUTE]]);
        });
    });
});

// ---------------------------------------------------------------------------------------------
// The install boundary: a reinstall must not silently resume the previous install's session (the
// iOS keychain outlives an uninstall), while an app update and a normal relaunch touch nothing.
// Real settings service, real keychain fake.
// ---------------------------------------------------------------------------------------------

describe('enforceInstallBoundary', () => {
    const CREDENTIALS = ['cookie', 'session_data', 'appattest_key_id', 'appattest_key_proven', 'device_attest_device_id'];

    async function seedKeychain(suffixes: string[]) {
        for (const suffix of suffixes) await secureStore.setItemAsync(key(suffix), `value-${suffix}`);
    }
    const present = (suffixes: string[]) => suffixes.filter((s) => secureStoreDump()[key(s)] !== undefined);

    it('fresh install with a surviving session: clears cookie, account credentials and the retired deviceRef, stamps the marker', async () => {
        await seedKeychain([...CREDENTIALS, 'device_ref']);

        await enforceInstallBoundary();

        expect(present([...CREDENTIALS, 'device_ref'])).toEqual([]);
        expect(await getSetting(HAS_LAUNCHED_SETTING_KEY)).toBe('1');
        expect(wasInstallBoundaryReset()).toBe(true);
    });

    it('normal relaunch (marker present): deletes only the retired deviceRef', async () => {
        await setSetting(HAS_LAUNCHED_SETTING_KEY, '1');
        await seedKeychain([...CREDENTIALS, 'device_ref']);

        await enforceInstallBoundary();

        expect(present([...CREDENTIALS, 'device_ref'])).toEqual(CREDENTIALS);
        expect(wasInstallBoundaryReset()).toBe(false);
    });

    it('app UPDATE (no marker yet, but cached_user_id survived): clears no credential, stamps the marker', async () => {
        await setSetting('cached_user_id', ME);
        await seedKeychain([...CREDENTIALS, 'device_ref']);

        await enforceInstallBoundary();

        expect(present([...CREDENTIALS, 'device_ref'])).toEqual(CREDENTIALS);
        expect(await getSetting(HAS_LAUNCHED_SETTING_KEY)).toBe('1');
        expect(wasInstallBoundaryReset()).toBe(false);
    });

    it('true first install (nothing anywhere): no clearing, marker stamped, no reset flag', async () => {
        await enforceInstallBoundary();

        expect(secureStoreDump()).toEqual({});
        expect(await getSetting(HAS_LAUNCHED_SETTING_KEY)).toBe('1');
        expect(wasInstallBoundaryReset()).toBe(false);
    });

    it('fail-safe: a throwing settings read clears no credential and leaves the marker unwritten', async () => {
        await seedKeychain([...CREDENTIALS, 'device_ref']);
        track(jest.spyOn(settingService, 'getSetting')).mockRejectedValue(new Error('cold DB'));

        await expect(enforceInstallBoundary()).resolves.toBeUndefined();

        spies.pop()?.mockRestore();
        expect(present([...CREDENTIALS, 'device_ref'])).toEqual(CREDENTIALS);
        expect(await getSetting(HAS_LAUNCHED_SETTING_KEY)).toBeNull();
        expect(wasInstallBoundaryReset()).toBe(false);
    });

    it('latches once per process', async () => {
        await enforceInstallBoundary();
        await deleteSetting(HAS_LAUNCHED_SETTING_KEY);

        await enforceInstallBoundary();

        // A second pass that really ran would have stamped the marker again.
        expect(await getSetting(HAS_LAUNCHED_SETTING_KEY)).toBeNull();
    });

    describe('auth-read quarantine (the get-session race)', () => {
        const sessionSignal = () =>
            (authClient as unknown as { $store: { atoms: { $sessionSignal: { get(): boolean } } } }).$store.atoms
                .$sessionSignal;

        it('hides the session cookie from sync reads until the boundary decides, then pokes the session signal', async () => {
            await seedKeychain(['cookie']);
            await setSetting(HAS_LAUNCHED_SETTING_KEY, '1');
            // BEFORE the boundary: the racing /get-session must find no cookie, though it is stored.
            expect(isAuthReadQuarantined(key('cookie'))).toBe(true);
            expect(isAuthReadQuarantined(key('session_data'))).toBe(true);
            expect(isAuthReadQuarantined(key('device_ref'))).toBe(false);
            expect(secureStore.getItem(key('cookie'))).toBeNull();
            const before = sessionSignal().get();

            await enforceInstallBoundary();

            expect(isAuthReadQuarantined(key('cookie'))).toBe(false);
            expect(secureStore.getItem(key('cookie'))).toBe('value-cookie');
            // The atom refetches against the now-authoritative keychain.
            expect(sessionSignal().get()).toBe(!before);
        });

        it('releases on the first-install path too', async () => {
            await enforceInstallBoundary();
            expect(isAuthReadQuarantined(key('cookie'))).toBe(false);
        });

        it('releases even when the settings read throws (fail-safe path)', async () => {
            const before = sessionSignal().get();
            track(jest.spyOn(settingService, 'getSetting')).mockRejectedValue(new Error('cold DB'));

            await enforceInstallBoundary();

            expect(isAuthReadQuarantined(key('cookie'))).toBe(false);
            expect(sessionSignal().get()).toBe(!before);
        });
    });

    it('a failing retired-deviceRef delete blocks nothing and is not a boundary reset', async () => {
        await setSetting(HAS_LAUNCHED_SETTING_KEY, '1');
        failSecureStore(key('device_ref'), 'delete');

        await expect(enforceInstallBoundary()).resolves.toBeUndefined();

        expect(wasInstallBoundaryReset()).toBe(false);
        expect(isAuthReadQuarantined(key('cookie'))).toBe(false);
    });
});

// ---------------------------------------------------------------------------------------------
// identity-gate: the pure verdicts and the process-lived recorders, called directly.
// ---------------------------------------------------------------------------------------------

describe('resolveIdentity', () => {
    it('coherent: session and cached owner are the same user', () => {
        expect(resolveIdentity({ sessionUserId: 'A', cachedUserId: 'A' })).toBe('coherent');
    });

    it('wipeAndProceed: session belongs to a different user than the on-device data', () => {
        expect(resolveIdentity({ sessionUserId: 'B', cachedUserId: 'A' })).toBe('wipeAndProceed');
    });

    it('wipeAndProceed: signed in with nothing stamped yet (fresh login)', () => {
        expect(resolveIdentity({ sessionUserId: 'B', cachedUserId: null })).toBe('wipeAndProceed');
    });

    it('reauth: an observed ownership fault, ids agreeing', () => {
        expect(resolveIdentity({ sessionUserId: 'A', cachedUserId: 'A', ownershipFault: true })).toBe('reauth');
    });

    // The fault check MUST precede the id comparison: a fault with mismatched ids must not be
    // "fixed" by a local wipe the server has already contradicted.
    it('reauth wins over wipeAndProceed when a fault coincides with mismatched ids', () => {
        expect(resolveIdentity({ sessionUserId: 'B', cachedUserId: 'A', ownershipFault: true })).toBe('reauth');
    });

    it('never ejects a confirmed-offline device, even with a fault', () => {
        expect(
            resolveIdentity({ sessionUserId: 'A', cachedUserId: 'A', ownershipFault: true, isConnected: false }),
        ).toBe('coherent');
    });

    it('treats unknown connectivity as online (acts on the fault)', () => {
        expect(
            resolveIdentity({ sessionUserId: 'A', cachedUserId: 'A', ownershipFault: true, isConnected: undefined }),
        ).toBe('reauth');
    });

    it('never ejects when the auth server is confirmed unreachable, even with a fault', () => {
        expect(
            resolveIdentity({
                sessionUserId: 'A',
                cachedUserId: 'A',
                ownershipFault: true,
                isConnected: true,
                serverReachable: false,
            }),
        ).toBe('coherent');
    });

    it('treats unknown server reachability as reachable (acts on the fault)', () => {
        expect(
            resolveIdentity({
                sessionUserId: 'A',
                cachedUserId: 'A',
                ownershipFault: true,
                isConnected: true,
                serverReachable: undefined,
            }),
        ).toBe('reauth');
    });

    it('ejects as before once the server IS reachable: deferral, not cancellation', () => {
        expect(
            resolveIdentity({
                sessionUserId: 'A',
                cachedUserId: 'A',
                ownershipFault: true,
                isConnected: true,
                serverReachable: true,
            }),
        ).toBe('reauth');
    });

    // The deferral must NOT swallow the cross-user wipe.
    it('still wipes on a deferred fault whose ids genuinely disagree', () => {
        expect(
            resolveIdentity({
                sessionUserId: 'B',
                cachedUserId: 'A',
                ownershipFault: true,
                isConnected: true,
                serverReachable: false,
            }),
        ).toBe('wipeAndProceed');
    });

    it('callers that omit serverReachable are unaffected', () => {
        expect(resolveIdentity({ sessionUserId: 'A', cachedUserId: 'A', ownershipFault: true })).toBe('reauth');
    });

    it('coherent: no live session is the OFFLINE path, not a fault', () => {
        expect(resolveIdentity({ sessionUserId: null, cachedUserId: 'A' })).toBe('coherent');
        expect(resolveIdentity({ sessionUserId: undefined, cachedUserId: 'A' })).toBe('coherent');
    });

    it('coherent: no identity at all', () => {
        expect(resolveIdentity({})).toBe('coherent');
    });

    // THE BUG the recorder fixes: user A's data on the device, user B signs in before the session
    // atom settles. This used to return 'coherent' and let B into A's data.
    it('wipeAndProceed: an UNRESOLVED session with a recorded sign-in as a different user', () => {
        expect(
            resolveIdentity({ sessionUserId: undefined, pendingAuthUserId: 'B', cachedUserId: 'A' }),
        ).toBe('wipeAndProceed');
    });

    it('coherent: an unresolved session with a recorded sign-in as the SAME user', () => {
        expect(
            resolveIdentity({ sessionUserId: undefined, pendingAuthUserId: 'A', cachedUserId: 'A' }),
        ).toBe('coherent');
    });

    it('wipeAndProceed: recorded sign-in with nothing stamped on disk yet', () => {
        expect(
            resolveIdentity({ sessionUserId: null, pendingAuthUserId: 'B', cachedUserId: null }),
        ).toBe('wipeAndProceed');
    });

    it('a recorded id cannot override a resolved session that agrees with disk', () => {
        expect(
            resolveIdentity({ sessionUserId: 'A', pendingAuthUserId: 'B', cachedUserId: 'A' }),
        ).toBe('coherent');
    });

    // The coalesce goes AFTER the fault check; above it a fault carrying a recorded id would wipe
    // data the SERVER has said we are wrong about.
    it('reauth still wins over a recorded id when a fault is present', () => {
        expect(
            resolveIdentity({
                sessionUserId: undefined,
                pendingAuthUserId: 'B',
                cachedUserId: 'A',
                ownershipFault: true,
            }),
        ).toBe('reauth');
    });

    it('still wipes on a DEFERRED fault whose recorded id disagrees with disk', () => {
        expect(
            resolveIdentity({
                sessionUserId: undefined,
                pendingAuthUserId: 'B',
                cachedUserId: 'A',
                ownershipFault: true,
                isConnected: true,
                serverReachable: false,
            }),
        ).toBe('wipeAndProceed');
    });

    it('an explicit null recorded id changes nothing (the offline shape)', () => {
        expect(resolveIdentity({ sessionUserId: null, pendingAuthUserId: null, cachedUserId: 'A' })).toBe('coherent');
    });
});

describe('effectiveSessionUserId', () => {
    it('THE ATOM WINS on conflict: the recorder only ever fills a hole', () => {
        expect(effectiveSessionUserId('B', 'C')).toBe('B');
    });

    it('falls back to the recorder when the session has not resolved', () => {
        expect(effectiveSessionUserId(undefined, 'C')).toBe('C');
        expect(effectiveSessionUserId(null, 'C')).toBe('C');
    });

    it('returns null, not undefined, when neither is present', () => {
        expect(effectiveSessionUserId(undefined, undefined)).toBeNull();
        expect(effectiveSessionUserId(null, null)).toBeNull();
    });

    it('treats an empty-string session id as absent, not as an identity', () => {
        expect(effectiveSessionUserId('', 'C')).toBe('C');
        expect(effectiveSessionUserId('', '')).toBeNull();
    });
});

describe('recordAuthenticatedUser', () => {
    it('round-trips the id and clears on consumption', () => {
        expect(readPendingAuthUserId()).toBeNull();
        recordAuthenticatedUser('B');
        expect(readPendingAuthUserId()).toBe('B');
        clearPendingAuthUserId();
        expect(readPendingAuthUserId()).toBeNull();
    });

    it('normalises an absent id to null rather than storing undefined', () => {
        recordAuthenticatedUser(undefined);
        expect(readPendingAuthUserId()).toBeNull();
        recordAuthenticatedUser('');
        expect(readPendingAuthUserId()).toBeNull();
    });

    it('the last sign-in wins: a second account overwrites the first', () => {
        recordAuthenticatedUser('B');
        recordAuthenticatedUser('C');
        expect(readPendingAuthUserId()).toBe('C');
    });
});

describe('the blocking-screen latch', () => {
    it('is off by default and round-trips', () => {
        expect(isIdentitySwitchBlocked()).toBe(false);
        setIdentitySwitchBlocked(true);
        expect(isIdentitySwitchBlocked()).toBe(true);
        setIdentitySwitchBlocked(false);
        expect(isIdentitySwitchBlocked()).toBe(false);
    });
});

describe('isOwnershipFault: the exact server error match', () => {
    const OWNERSHIP = {
        message: 'Access denied: resource belongs to another user',
        extensions: { code: 'FORBIDDEN', statusCode: 403 },
    };

    it('matches the server ownership rejection', () => {
        expect(isOwnershipFault(OWNERSHIP)).toBe(true);
    });

    it('matches on statusCode 403 even if the code is missing', () => {
        expect(isOwnershipFault({ message: OWNERSHIP.message, extensions: { statusCode: 403 } })).toBe(true);
    });

    it('does NOT match a different FORBIDDEN error (code alone is too broad)', () => {
        expect(isOwnershipFault({ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } })).toBe(false);
    });

    it('does not match other error codes carrying a similar message', () => {
        expect(
            isOwnershipFault({ message: OWNERSHIP.message, extensions: { code: 'INTERNAL_SERVER_ERROR' } }),
        ).toBe(false);
    });

    it('does not match UNAUTHENTICATED / PAYMENT_REQUIRED', () => {
        expect(isOwnershipFault({ message: 'x', extensions: { code: 'UNAUTHENTICATED' } })).toBe(false);
        expect(isOwnershipFault({ message: 'x', extensions: { code: 'PAYMENT_REQUIRED' } })).toBe(false);
    });

    it('tolerates missing/empty input', () => {
        expect(isOwnershipFault(null)).toBe(false);
        expect(isOwnershipFault(undefined)).toBe(false);
        expect(isOwnershipFault({})).toBe(false);
    });
});

describe('recordOwnershipFault: loop guard and recovery flow', () => {
    const captureMessage = Sentry.captureMessage as jest.Mock;
    const faultRow = () => getSetting(IDENTITY_FAULT_KEY);

    it('flips needsReauth, persists the marker and logs ONE Sentry message', async () => {
        recordOwnershipFault({ operationName: 'ArticleIdsForPersona' });

        expect(useUserStore.getState().needsReauth).toBe(true);
        await waitFor(async () => expect(await faultRow()).toBe('1'));
        expect(captureMessage).toHaveBeenCalledTimes(1);
        expect(captureMessage.mock.calls[0][1]).toMatchObject({ tags: { source: 'identity-gate' } });
    });

    it('is idempotent per app session: a second fault does not re-trigger', async () => {
        const writes: string[] = [];
        const real = settingService.setSetting;
        track(jest.spyOn(settingService, 'setSetting')).mockImplementation((k, v) => {
            writes.push(k);
            return real(k, v);
        });

        recordOwnershipFault({ operationName: 'A' });
        recordOwnershipFault({ operationName: 'B' });
        recordOwnershipFault({ operationName: 'C' });
        await waitFor(async () => expect(await faultRow()).toBe('1'));

        expect(captureMessage).toHaveBeenCalledTimes(1);
        expect(writes.filter((k) => k === IDENTITY_FAULT_KEY)).toHaveLength(1);
    });

    it('re-arms after the fault is cleared', async () => {
        recordOwnershipFault();
        await clearIdentityFault();
        recordOwnershipFault();

        expect(captureMessage).toHaveBeenCalledTimes(2);
    });
});

describe('hasIdentityFault / clearIdentityFault', () => {
    it('reports a persisted fault', async () => {
        await setSetting(IDENTITY_FAULT_KEY, '1');
        await expect(hasIdentityFault()).resolves.toBe(true);
    });

    it('reports no fault when the marker is absent or not "1"', async () => {
        await expect(hasIdentityFault()).resolves.toBe(false);
        await setSetting(IDENTITY_FAULT_KEY, '0');
        await expect(hasIdentityFault()).resolves.toBe(false);
    });

    it('returns false rather than throwing when the DB is unavailable', async () => {
        await setSetting(IDENTITY_FAULT_KEY, '1');
        track(jest.spyOn(settingService, 'getSetting')).mockRejectedValueOnce(new Error('db gone'));
        await expect(hasIdentityFault()).resolves.toBe(false);
    });

    it('deletes the persisted marker', async () => {
        await setSetting(IDENTITY_FAULT_KEY, '1');
        await clearIdentityFault();
        await waitFor(async () => expect(await getSetting(IDENTITY_FAULT_KEY)).toBeNull());
    });
});

// "Sign in without email" opened a DIFFERENT account and the person has not answered "switch?".
// Every gate must read that session as unresolved, or it wipes this device's account unasked.
describe('held account switch', () => {
    it('a held session reads as unresolved: no wipe of the account on disk', () => {
        holdAccountSwitch('phone');
        expect(effectiveSessionUserId('phone', null)).toBeNull();
        expect(resolveIdentity({ sessionUserId: 'phone', cachedUserId: 'email', isConnected: true })).toBe('coherent');
    });

    it('is keyed on the id: any OTHER account still resolves and still wipes', () => {
        holdAccountSwitch('phone');
        expect(effectiveSessionUserId('other', null)).toBe('other');
        expect(resolveIdentity({ sessionUserId: 'other', cachedUserId: 'email', isConnected: true })).toBe(
            'wipeAndProceed',
        );
    });

    it('releasing it restores the normal verdict (the confirmed switch wipes)', () => {
        holdAccountSwitch('phone');
        releaseAccountSwitch();
        expect(isAccountSwitchHeld('phone')).toBe(false);
        expect(resolveIdentity({ sessionUserId: 'phone', cachedUserId: 'email', isConnected: true })).toBe(
            'wipeAndProceed',
        );
    });

    it('never holds an empty id, and the test reset clears it', () => {
        expect(isAccountSwitchHeld(undefined)).toBe(false);
        holdAccountSwitch('');
        expect(isAccountSwitchHeld('')).toBe(false);
        holdAccountSwitch('phone');
        __resetIdentityStateForTests();
        expect(isAccountSwitchHeld('phone')).toBe(false);
    });
});
