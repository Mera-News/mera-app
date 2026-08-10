import { create } from 'zustand';
import { Dimensions } from 'react-native';
import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
  DEFAULT_TEXT_SCALE,
  defaultTextScaleForWidth,
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
      // `null` (no row) means the user has never chosen. That must NOT be
      // coerced through `nearestTextScale` (there is nothing stored to snap),
      // but it also no longer means "always render 1x" — on a small screen,
      // 1x is genuinely harder to read, so the DEFAULT itself is derived from
      // screen width. This is never persisted: writing it would forge an
      // explicit choice the user never made, one they'd then carry to a
      // different, differently-sized device.
      //
      // `Dimensions.get('window')`, not `useWindowDimensions` — `hydrate()`
      // runs outside React, called from `lib/database/hydrate-stores.ts`
      // before any component tree exists.
      set({
        scale:
          raw === null
            ? defaultTextScaleForWidth(Dimensions.get('window').width)
            : nearestTextScale(Number(raw)),
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
