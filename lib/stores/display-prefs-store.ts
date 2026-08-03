import { create } from 'zustand';
import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';

const SETTING_KEY = 'static_gradient';

interface DisplayPrefsState {
    /** Renders the app-wide gradient backdrop as a single static frame — the
     *  same mode OS Reduce Motion selects. Off by default: the animation is
     *  the designed look, and this is the opt-out. */
    staticGradient: boolean;
    hydrated: boolean;
    hydrate: () => Promise<void>;
    setStaticGradient: (value: boolean) => void;
}

export const useDisplayPrefsStore = create<DisplayPrefsState>()((set) => ({
    staticGradient: false,
    hydrated: false,

    hydrate: async () => {
        try {
            const raw = await getSetting(SETTING_KEY);
            set({ staticGradient: raw === '1', hydrated: true });
        } catch (err) {
            logger.captureException(err, { tags: { store: 'display-prefs-store' } });
            set({ hydrated: true });
        }
    },

    setStaticGradient: (value) => {
        set({ staticGradient: value });
        setSetting(SETTING_KEY, value ? '1' : '0').catch((err) =>
            logger.captureException(err, { tags: { store: 'display-prefs-store' } }),
        );
    },
}));
