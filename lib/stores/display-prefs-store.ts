import { create } from 'zustand';
import * as Device from 'expo-device';
import logger from '@/lib/logger';
import {
  classifyDevice,
  overrideFromLegacyStaticGradient,
  readPerformanceOverride,
  resolvePerformanceMode,
  writePerformanceOverride,
  type PerformanceMode,
  type PerformanceOverride,
} from '@/lib/performance/performance-mode';

/** The old "Static background" row. Read once to carry an explicit choice over
 *  into Lite mode, then deleted. */
const LEGACY_STATIC_GRADIENT_KEY = 'static_gradient';

interface DisplayPrefsState {
    /**
     * Lite mode (lib/performance/performance-mode.ts): the animated backdrop,
     * looping scenes, card arrival motion and decorative logo loops all render
     * as a still frame. Read this, never the device class: it already folds in
     * the reader's own choice.
     */
    liteMode: boolean;
    /** What this phone gets when the reader has not chosen. */
    deviceMode: PerformanceMode;
    /** The reader's choice; `auto` follows `deviceMode`. */
    performanceOverride: PerformanceOverride;
    hydrated: boolean;
    hydrate: () => Promise<void>;
    setPerformanceOverride: (value: PerformanceOverride) => void;
}

// Derived synchronously at module load: `Device.totalMemory` is a constant, so
// a Lite phone never paints one animated frame while hydration is in flight.
const initialDeviceMode = classifyDevice(Device.totalMemory);

export const useDisplayPrefsStore = create<DisplayPrefsState>()((set, get) => ({
    liteMode: initialDeviceMode === 'lite',
    deviceMode: initialDeviceMode,
    performanceOverride: 'auto',
    hydrated: false,

    hydrate: async () => {
        const deviceMode = classifyDevice(Device.totalMemory);
        try {
            let override = await readPerformanceOverride();
            if (override === null) {
                // First launch on this version: carry an explicit "Static
                // background" choice over. No row means the reader never chose.
                // Required lazily: MeraLogo reads this store, and a module-level
                // import would pull the database into every card's import graph
                // (a card suite then dies on initializeJSI). Not `import()`:
                // that splits a chunk the dev client cannot load in --no-dev.
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { getSetting, deleteSetting } = require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');
                const legacy = await getSetting(LEGACY_STATIC_GRADIENT_KEY).catch(() => null);
                override = overrideFromLegacyStaticGradient(legacy);
                await writePerformanceOverride(override);
                if (legacy !== null) await deleteSetting(LEGACY_STATIC_GRADIENT_KEY).catch(() => undefined);
            }
            set({
                deviceMode,
                performanceOverride: override,
                liteMode: resolvePerformanceMode(override, deviceMode) === 'lite',
                hydrated: true,
            });
        } catch (err) {
            logger.captureException(err, { tags: { store: 'display-prefs-store' } });
            set({ deviceMode, liteMode: resolvePerformanceMode(get().performanceOverride, deviceMode) === 'lite', hydrated: true });
        }
    },

    setPerformanceOverride: (value) => {
        set({ performanceOverride: value, liteMode: resolvePerformanceMode(value, get().deviceMode) === 'lite' });
        writePerformanceOverride(value).catch((err) =>
            logger.captureException(err, { tags: { store: 'display-prefs-store' } }),
        );
    },
}));
