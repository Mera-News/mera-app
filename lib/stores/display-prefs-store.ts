import { create } from 'zustand';
import * as Device from 'expo-device';
import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';

const SETTING_KEY = 'static_gradient';

/**
 * Below this much RAM, the animated backdrop defaults to OFF.
 *
 * The same 6 GB line `lib/mera-protocol-toolkit/core/systemRequirements.ts`
 * uses to gate on-device inference — reused deliberately rather than inventing
 * a second device threshold. It is the only static capability signal the app
 * actually has (`expo-device` exposes no GPU/NPU surface), and the mode it
 * selects already exists and is already the cheapest one the backdrop can run
 * in: a single static frame, no clock, no timer, no animated styles
 * (AbstractGradientBackdrop.tsx:415-418).
 *
 * This is the WHOLE of the device-tiering work. No tier enum, no capability
 * registry — the only friction that exists is "older phones run the animated
 * backdrop badly", and one boolean already solves it.
 */
const LOW_MEMORY_BYTES = 6 * 1024 * 1024 * 1024;

/** The default when the user has never expressed a preference. `null` from
 *  `Device.totalMemory` means "couldn't determine", which must NOT be read as
 *  "low" — an unknown device keeps the designed look. */
function defaultStaticGradient(): boolean {
  const total = Device.totalMemory;
  return typeof total === 'number' && total > 0 && total < LOW_MEMORY_BYTES;
}

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
            // `null` (no row) and `'0'` are DIFFERENT: null means the user has
            // never chosen, so the device-derived default applies; '0' is an
            // explicit "keep it animated" and must never be overridden. The old
            // `raw === '1'` collapsed both into false and made the derived
            // default unreachable.
            set({
                staticGradient: raw === null ? defaultStaticGradient() : raw === '1',
                hydrated: true,
            });
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
