import { create } from 'zustand';
import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';

const SETTING_KEY = 'pinned_country_codes';

interface PinnedCountriesState {
    pinnedCodes: string[];
    hydrated: boolean;
    hydrate: () => Promise<void>;
    togglePin: (code: string) => void;
}

export const usePinnedCountriesStore = create<PinnedCountriesState>()((set, get) => ({
    pinnedCodes: [],
    hydrated: false,

    hydrate: async () => {
        try {
            const raw = await getSetting(SETTING_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            set({ pinnedCodes: Array.isArray(parsed) ? parsed : [], hydrated: true });
        } catch (err) {
            logger.captureException(err, { tags: { store: 'pinned-countries-store' } });
            set({ hydrated: true });
        }
    },

    togglePin: (code) => {
        const current = get().pinnedCodes;
        const next = current.includes(code)
            ? current.filter((c) => c !== code)
            : [...current, code];
        set({ pinnedCodes: next });
        setSetting(SETTING_KEY, JSON.stringify(next)).catch((err) =>
            logger.captureException(err, { tags: { store: 'pinned-countries-store' } }),
        );
    },
}));
