// Guarded haptics helpers.
//
// `expo-haptics` is a native module — it is absent in builds/environments
// without the native side (e.g. web, Jest, an unlinked binary). Rather than
// let a missing module crash a UI interaction, every helper lazily requires
// the module inside a try/catch and no-ops when it isn't available.

type HapticsModule = typeof import('expo-haptics');

let cachedModule: HapticsModule | null | undefined;

/** Lazily resolves expo-haptics, caching the result (including unavailability). */
function getHaptics(): HapticsModule | null {
    if (cachedModule !== undefined) return cachedModule;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        cachedModule = require('expo-haptics') as HapticsModule;
    } catch {
        cachedModule = null;
    }
    return cachedModule;
}

/** Light impact — for small taps and selection changes. */
export async function hapticLight(): Promise<void> {
    try {
        const Haptics = getHaptics();
        if (!Haptics) return;
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
        // Swallow — haptics are best-effort feedback, never critical.
    }
}

/** Medium impact — for more deliberate actions (open/close, drag snap). */
export async function hapticMedium(): Promise<void> {
    try {
        const Haptics = getHaptics();
        if (!Haptics) return;
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {
        // Swallow — haptics are best-effort feedback, never critical.
    }
}

/** Success notification — for confirmations (fact saved, action completed). */
export async function hapticSuccess(): Promise<void> {
    try {
        const Haptics = getHaptics();
        if (!Haptics) return;
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
        // Swallow — haptics are best-effort feedback, never critical.
    }
}
