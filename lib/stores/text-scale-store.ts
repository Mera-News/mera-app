import { create } from 'zustand';
import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
  DEFAULT_TEXT_SCALE,
  nearestTextScale,
  type TextScale,
} from '@/lib/typography/scale';

const SETTING_KEY = 'text_scale';

// The step list, labels and `nearestTextScale` live in `lib/typography/scale.ts`
// so they can be read without pulling the database in — see the note there.
// Re-exported for convenience at call sites that want both.
export {
  DEFAULT_TEXT_SCALE,
  TEXT_SCALE_LABEL_KEYS,
  TEXT_SCALE_STEPS,
  nearestTextScale,
  type TextScale,
} from '@/lib/typography/scale';

interface TextScaleState {
  /** Multiplier applied to every `fontSize`/`lineHeight` in the app's type
   *  scale. `1` renders the designed sizes. */
  scale: TextScale;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setScale: (value: TextScale) => void;
}

export const useTextScaleStore = create<TextScaleState>()((set) => ({
  scale: DEFAULT_TEXT_SCALE,
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await getSetting(SETTING_KEY);
      // `null` (no row) means the user has never chosen, which must render the
      // designed size rather than being coerced through `nearestTextScale`.
      set({
        scale: raw === null ? DEFAULT_TEXT_SCALE : nearestTextScale(Number(raw)),
        hydrated: true,
      });
    } catch (err) {
      logger.captureException(err, { tags: { store: 'text-scale-store' } });
      set({ hydrated: true });
    }
  },

  setScale: (value) => {
    set({ scale: value });
    setSetting(SETTING_KEY, String(value)).catch((err) =>
      logger.captureException(err, { tags: { store: 'text-scale-store' } }),
    );
  },
}));
