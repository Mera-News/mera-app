import { create } from 'zustand';
import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';

const SETTING_KEY = 'for_you_recent_24h_only';

interface ForYouPrefsState {
    recent24hOnly: boolean;
    hydrated: boolean;
    hydrate: () => Promise<void>;
    setRecent24hOnly: (value: boolean) => void;
}

export const useForYouPrefsStore = create<ForYouPrefsState>()((set) => ({
    recent24hOnly: false,
    hydrated: false,

    hydrate: async () => {
        try {
            const raw = await getSetting(SETTING_KEY);
            set({ recent24hOnly: raw === '1', hydrated: true });
        } catch (err) {
            logger.captureException(err, { tags: { store: 'for-you-prefs-store' } });
            set({ hydrated: true });
        }
    },

    setRecent24hOnly: (value) => {
        set({ recent24hOnly: value });
        setSetting(SETTING_KEY, value ? '1' : '0').catch((err) =>
            logger.captureException(err, { tags: { store: 'for-you-prefs-store' } }),
        );
    },
}));
