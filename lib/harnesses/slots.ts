// A harness's prompt slots: the .md files of its folder overlaid on its base's, compiled by
// `npm run harness:generate` into slots.generated.ts (Metro cannot read a directory or a .md at
// runtime). The on-device prompt modules read DEVICE_SLOTS, so an override in afm/ reaches every
// on-device request; the cloud prompt modules still read cloud-base directly.
import { loadHarness } from './index';
import { HARNESS_SLOTS, type DeviceBaseSlot } from './slots.generated';

/** Every slot the harness in `folder` sees, its base's first and each override after. */
export function resolveSlots(folder: string): Record<string, string> {
  return Object.assign({}, ...loadHarness(folder).chain.map((f) => HARNESS_SLOTS[f] ?? {}));
}

/**
 * The harness every on-device prompt is read from. shortcut: one folder for every built-in
 * model, because only Apple's is linked; pick per TextEngine once Gemini Nano links.
 */
export const ON_DEVICE_HARNESS = 'afm';

/** The on-device slots as the built-in model receives them: device-base plus afm's overrides. */
export const DEVICE_SLOTS = resolveSlots(ON_DEVICE_HARNESS) as Record<DeviceBaseSlot, string>;
