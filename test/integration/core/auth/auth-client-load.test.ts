// A background wake loads lib/auth-client for the first time AFTER the install boundary has lifted
// the read quarantine, so better-auth's Expo client finds the cached session and mounts the session
// atom while the module is still loading. That mount reaches the client's `import("expo-network")`,
// and a release bundle evaluates it at once: a missing module threw "Cannot find module" from inside
// lib/auth-client and ended the wake (Sentry MERA-APP-A7). Each case loads its own copy.
import Constants from 'expo-constants';

const SLUG = (Constants.expoConfig as { slug?: string } | null)?.slug || 'app';

function seedSessionCache(): void {
    const { secureStore } = require('@/lib/utils/secure-store-adapter');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    secureStore.setItem(
        `${SLUG}_session_data`,
        JSON.stringify({
            session: { id: 'session-1', userId: 'user-1', expiresAt },
            user: { id: 'user-1', email: 'reader@anon.mera.news' },
        }),
    );
}

it('loads after the read quarantine lifts with a cached session, as a background wake does', () => {
    jest.isolateModules(() => {
        require('@/lib/app-host');
        seedSessionCache();
        require('@/lib/security/install-boundary-latch').releaseAuthReadQuarantine();
        expect(() => require('@/lib/auth-client')).not.toThrow();
        // The cached session reached the atom, so this run took the path that threw.
        expect(require('@/lib/auth-client').authClient.$store.atoms.session.get().data?.user?.id).toBe('user-1');
    });
});

it('loads under the quarantine with a cached session, as a foreground cold start does', () => {
    jest.isolateModules(() => {
        require('@/lib/app-host');
        seedSessionCache();
        expect(() => require('@/lib/auth-client')).not.toThrow();
    });
});
