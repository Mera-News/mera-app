// The keychain keys better-auth's expo client writes are named from the app config, so a renamed
// fork never silently writes `meraapp_cookie`. The neutral `app` fallback for a config with no slug
// is not testable here: expo-linking, which the expo client reaches, throws without a scheme.
// Each case loads a fresh copy of the auth client under its own expo-constants (an edge), so the
// secure-store Map it writes to is that copy's own.
import { FIXTURE_ACCOUNT } from '@/test/helpers';

type Loaded = {
    authClient: typeof import('@/lib/auth-client').authClient;
    secureStoreDump: () => Record<string, string>;
    releaseAuthReadQuarantine: () => void;
};

function loadWithConfig(expoConfig: Record<string, unknown>): Loaded {
    let loaded!: Loaded;
    jest.isolateModules(() => {
        jest.doMock('expo-constants', () => ({
            __esModule: true,
            default: { executionEnvironment: 'standalone', appOwnership: null, expoConfig },
            ExecutionEnvironment: { Bare: 'bare', Standalone: 'standalone', StoreClient: 'storeClient' },
            AppOwnership: { Expo: 'expo' },
        }));
        loaded = {
            authClient: require('@/lib/auth-client').authClient,
            secureStoreDump: require('@/test/helpers/storage').secureStoreDump,
            releaseAuthReadQuarantine: require('@/lib/security/install-boundary-latch').releaseAuthReadQuarantine,
        };
    });
    return loaded;
}

async function signIn({ authClient, releaseAuthReadQuarantine }: Loaded) {
    releaseAuthReadQuarantine();
    const { error } = await authClient.signIn.emailOtp({ email: FIXTURE_ACCOUNT.email, otp: FIXTURE_ACCOUNT.otp });
    expect(error).toBeNull();
}

afterEach(() => {
    jest.dontMock('expo-constants');
});

it('prefixes the keys with the app slug', async () => {
    const loaded = loadWithConfig({ scheme: 'forkapp', slug: 'forkapp-slug' });
    await signIn(loaded);
    expect(Object.keys(loaded.secureStoreDump())).toEqual(['forkapp-slug_cookie']);
});

it('takes the first scheme when the config lists several', async () => {
    const loaded = loadWithConfig({ scheme: ['first', 'second'], slug: 'multi' });
    await signIn(loaded);
    expect(Object.keys(loaded.secureStoreDump())).toEqual(['multi_cookie']);
});
