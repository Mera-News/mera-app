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
    userPersona: UserPersona | null;
    isLoading: boolean;
    lastFetchedAt: number | null;

    // Actions
    setUserId: (id: string | null) => void;
    setUserPersona: (persona: UserPersona | null) => void;
    fetchUserPersona: (userId: string, force?: boolean) => Promise<UserPersona | null>;
    fetchUserPersonaOrThrow: (userId: string, force?: boolean) => Promise<UserPersona | null>;
    clearUser: () => void;
    hydrateFromDb: () => Promise<void>;
}

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
    userPersona: null,
    isLoading: false,
    lastFetchedAt: null,

    setUserId: (id) => {
        set({ userId: id });
        if (id) {
            setSetting('cached_user_id', id).catch(() => {});
        } else {
            deleteSetting('cached_user_id').catch(() => {});
        }
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
            userPersona: null,
            isLoading: false,
            lastFetchedAt: null,
        });
        clearUserPersona().catch(() => {});
        deleteSetting('cached_user_id').catch(() => {});
        deleteSetting('cached_user_email').catch(() => {});
    },

    hydrateFromDb: async () => {
        try {
            const userId = await getSetting('cached_user_id');
            if (!userId) return;

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
