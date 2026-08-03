import { create } from 'zustand';
import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';

const SETTING_KEY = 'blur_images';

interface BlurImagesState {
    blurImages: boolean;
    hydrated: boolean;
    hydrate: () => Promise<void>;
    setBlurImages: (value: boolean) => void;
}

export const useBlurImagesStore = create<BlurImagesState>()((set) => ({
    blurImages: false,
    hydrated: false,

    hydrate: async () => {
        try {
            const raw = await getSetting(SETTING_KEY);
            set({ blurImages: raw === '1', hydrated: true });
        } catch (err) {
            logger.captureException(err, { tags: { store: 'blur-images-store' } });
            set({ hydrated: true });
        }
    },

    setBlurImages: (value) => {
        set({ blurImages: value });
        setSetting(SETTING_KEY, value ? '1' : '0').catch((err) =>
            logger.captureException(err, { tags: { store: 'blur-images-store' } }),
        );
    },
}));
