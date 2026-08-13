import { create } from 'zustand';
import { AccountService, UserPersona } from '@/lib/account-service';
import logger from '@/lib/logger';
import {
    persistUserPersona,
    loadUserPersona,
    clearUserPersona,
} from '@/lib/database/services/user-persona-service';
import { getSetting, setSetting, deleteSetting } from '@/lib/database/services/setting-service';

interface UserState {
    userId: string | null;
    /**
     * The signed-in email, read from the LOCAL `cached_user_email` row that the
     * OTP / deep-link verify screens already write at sign-in.
     *
     * Local on purpose. Settings used to render `session?.user?.email` straight
     * from better-auth, so any window where the server session could not be
     * fetched — offline, a keychain-locked background wake, a 401 blip — showed
     * a signed-in user NO email, which reads as "I have been logged out" (that
     * is exactly how it was reported). Identity is a local fact here; the same
     * rule the launch gate already applies (lib/security/launch-route.ts).
     * Only an explicit logout clears it.
     */
    userEmail: string | null;
    userPersona: UserPersona | null;
    isLoading: boolean;
    lastFetchedAt: number | null;
    // Set by the auth-failure breaker when the server session is confirmed dead.
    // The user is NOT ejected — data + PIN stay intact; a banner prompts a
    // re-login, which clears this. Persisted so it survives relaunch.
    needsReauth: boolean;

    // Actions
    setUserId: (id: string | null) => void;
    adoptLocalUserId: (id: string) => void;
    setUserPersona: (persona: UserPersona | null) => void;
    setNeedsReauth: (v: boolean) => void;
    fetchUserPersona: (userId: string, force?: boolean) => Promise<UserPersona | null>;
    fetchUserPersonaOrThrow: (userId: string, force?: boolean) => Promise<UserPersona | null>;
    clearUser: () => void;
    hydrateFromDb: () => Promise<void>;
}

const NEEDS_REAUTH_KEY = 'needs_reauth';

// Cache duration: 5 minutes (in milliseconds)
const CACHE_DURATION = 5 * 60 * 1000;

/**
 * Shared fetch/cache/dedupe/persist logic behind fetchUserPersona and
 * fetchUserPersonaOrThrow. Guard against empty/falsy ids — the server rejects
 * these as "Access denied: resource belongs to another user" and Apollo then
 * treats it as an auth failure. Callers are expected to wait until a real
 * userId is available, so an empty userId resolves to null rather than
 * throwing (it is not a fetch failure).
 *
 * On a genuine fetch failure this logs via logger.captureException, resets
 * isLoading, and RETHROWS — callers decide whether to swallow (fetchUserPersona)
 * or propagate (fetchUserPersonaOrThrow).
 */
async function fetchUserPersonaCore(
    set: (partial: Partial<UserState>) => void,
    get: () => UserState,
    userId: string,
    force: boolean,
): Promise<UserPersona | null> {
    if (!userId) {
        return null;
    }

    const state = get();

    // Return cached persona if still valid and not forced
    if (
        !force &&
        state.userPersona &&
        state.userId === userId &&
        state.lastFetchedAt &&
        Date.now() - state.lastFetchedAt < CACHE_DURATION
    ) {
        return state.userPersona;
    }

    // Prevent duplicate fetches
    if (state.isLoading && state.userId === userId) {
        return state.userPersona;
    }

    try {
        set({ isLoading: true, userId });

        const persona = await AccountService.getUserPersona(userId);

        if (persona) {
            logger.info(
                `[user-store] persona fetched: notificationsEnabled=${persona.notificationsEnabled} preferredNotificationWindow=${JSON.stringify(persona.preferredNotificationWindow)}`,
            );
        }

        set({
            userPersona: persona,
            isLoading: false,
            lastFetchedAt: Date.now()
        });

        // Fire-and-forget persist
        if (persona) {
            persistUserPersona(userId, persona).catch(() => {});
        }

        return persona;
    } catch (error) {
        logger.captureException(error, {
            tags: { store: 'userStore', method: 'fetchUserPersona' },
        });
        set({ isLoading: false });
        throw error;
    }
}

export const useUserStore = create<UserState>()((set, get) => ({
    userId: null,
    userEmail: null,
    userPersona: null,
    isLoading: false,
    lastFetchedAt: null,
    needsReauth: false,

    setUserId: (id) => {
        set({ userId: id });
        if (id) {
            setSetting('cached_user_id', id).catch(() => {});
        } else {
            deleteSetting('cached_user_id').catch(() => {});
        }
    },

    /**
     * Adopt an owner that was read OFF DISK, without writing it back.
     *
     * Deliberately narrower than `setUserId`. The cold-start gate needs the
     * in-memory id populated for the screens downstream of it, but for a user
     * whose session has not resolved the only id available is the one
     * `cached_user_id` already holds — so re-stamping it is at best a no-op
     * write and at worst the thing that made a bad state STICKY: the gate used
     * to coalesce session ?? local and then write the result back, which
     * re-stamped the previous owner over an account switch it had just failed
     * to detect.
     *
     * `setUserId` stays the only writer. Absent a proven identity there is
     * nothing new to persist, and persisting a guess is how the guess survives
     * a relaunch.
     */
    adoptLocalUserId: (id) => {
        if (!id) return;
        set({ userId: id });
    },

    setUserPersona: (persona) => {
        set({
            userPersona: persona,
            lastFetchedAt: Date.now(),
        });
        // Fire-and-forget persist
        const userId = get().userId;
        if (userId && persona) {
            persistUserPersona(userId, persona).catch(() => {});
        }
    },

    // Idempotent: only touches state/DB when the value actually changes, so the
    // breaker and success paths can call it freely without chatty writes.
    setNeedsReauth: (v) => {
        if (get().needsReauth === v) return;
        set({ needsReauth: v });
        if (v) {
            setSetting(NEEDS_REAUTH_KEY, '1').catch(() => {});
        } else {
            deleteSetting(NEEDS_REAUTH_KEY).catch(() => {});
        }
    },

    fetchUserPersona: async (userId, force = false) => {
        try {
            return await fetchUserPersonaCore(set, get, userId, force);
        } catch {
            return null;
        }
    },

    fetchUserPersonaOrThrow: async (userId, force = false) => {
        return fetchUserPersonaCore(set, get, userId, force);
    },

    clearUser: () => {
        set({
            userId: null,
            userEmail: null,
            userPersona: null,
            isLoading: false,
            lastFetchedAt: null,
            needsReauth: false,
        });
        clearUserPersona().catch(() => {});
        deleteSetting('cached_user_id').catch(() => {});
        deleteSetting('cached_user_email').catch(() => {});
        deleteSetting(NEEDS_REAUTH_KEY).catch(() => {});
    },

    hydrateFromDb: async () => {
        try {
            const userId = await getSetting('cached_user_id');
            if (!userId) return;

            // Restore the persisted re-auth flag alongside identity (only
            // meaningful when a user exists on-device).
            const needsReauth = (await getSetting(NEEDS_REAUTH_KEY)) === '1';
            if (needsReauth) set({ needsReauth: true });

            // Written at sign-in by OTPVerificationView / DeepLinkVerifyScreen.
            // Read here so identity survives a server session we cannot reach.
            // Absent on installs that signed in before this row existed — the
            // consumers fall back to the session email, so a missing row costs
            // nothing beyond the pre-existing behaviour.
            const email = await getSetting('cached_user_email');
            if (email) set({ userEmail: email });

            const persona = await loadUserPersona(userId);
            if (persona) {
                logger.info(
                    `[user-store] persona hydrated: notificationsEnabled=${persona.notificationsEnabled} preferredNotificationWindow=${JSON.stringify(persona.preferredNotificationWindow)}`,
                );
                set({
                    userId,
                    userPersona: persona,
                    lastFetchedAt: null, // Force re-fetch on next access (DB cache has no TTL)
                });
            } else {
                set({ userId });
            }
        } catch (err) {
            logger.warn('[user-store] hydrateFromDb failed', { error: String(err) });
        }
    },
}));
