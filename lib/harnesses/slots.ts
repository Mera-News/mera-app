// A harness's prompt slots: the .md files of its folder overlaid on its base's, compiled by
// `npm run harness:generate` into slots.generated.ts (Metro cannot read a directory or a .md at
// runtime). The prompt modules read their base's slots directly, so an implementation's override
// reaches no request until a caller resolves its prompts through here.
import { loadHarness } from './index';
import { HARNESS_SLOTS } from './slots.generated';

/** Every slot the harness in `folder` sees, its base's first and each override after. */
export function resolveSlots(folder: string): Record<string, string> {
  return Object.assign({}, ...loadHarness(folder).chain.map((f) => HARNESS_SLOTS[f] ?? {}));
}
