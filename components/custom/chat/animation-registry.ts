/**
 * The FOURTH animation registry, and the only file in `components/custom/chat/`
 * that may hold an animation `require()`.
 *
 * Its twins are `components/custom/tutorials/animation-registry.ts`,
 * `components/custom/processing/animation-registry.ts` and
 * `components/custom/game-ui/animation-registry.ts`. They share one asset
 * directory and one contract (`assets/animations/README.md`) and are not merged:
 * one id family, one file.
 *
 * Metro resolves `require()` at BUNDLE time, so an entry pointing at a missing
 * file is a build error no runtime guard can catch. **An entry may exist here
 * only once its file is on disk**; `test/integration/feed/contracts/
 * animation-assets.test.ts` enforces both directions. An id with no entry
 * resolves to null and its consumer draws nothing.
 *
 * Two id families, matched by their EXACT prefixes `chat-strip-` and
 * `chat-step-`. Never match on `chat-`: `chat-where-mera-is.json` is a
 * tutorial hero and belongs to the tutorials registry.
 *
 * Theming: every drawn layer is named `ink`, `ink3` or `accent`, and the app
 * recolours them with `colorFilters` keyed on those names. Pass OPAQUE colours
 * (flatten alpha tokens against the surface): Android applies the filter as
 * SRC_ATOP, so a translucent colour tints instead of fading.
 */

export type ChatStripId =
  | 'chat-strip-phone'
  | 'chat-strip-attest'
  | 'chat-strip-secure'
  | 'chat-strip-think'
  | 'chat-strip-retry'
  | 'chat-strip-return'
  | 'chat-strip-device';

export type ChatStepKind = 'think' | 'skill' | 'facts' | 'place' | 'write' | 'remove' | 'ask' | 'web';

type ChatAnimationId = ChatStripId | `chat-step-${ChatStepKind}`;

export const CHAT_ANIMATIONS: Record<ChatAnimationId, unknown> = {
  'chat-strip-phone': require('@/assets/animations/chat-strip-phone.json'),
  'chat-strip-attest': require('@/assets/animations/chat-strip-attest.json'),
  'chat-strip-secure': require('@/assets/animations/chat-strip-secure.json'),
  'chat-strip-think': require('@/assets/animations/chat-strip-think.json'),
  'chat-strip-retry': require('@/assets/animations/chat-strip-retry.json'),
  'chat-strip-return': require('@/assets/animations/chat-strip-return.json'),
  'chat-strip-device': require('@/assets/animations/chat-strip-device.json'),
  'chat-step-think': require('@/assets/animations/chat-step-think.json'),
  'chat-step-skill': require('@/assets/animations/chat-step-skill.json'),
  'chat-step-facts': require('@/assets/animations/chat-step-facts.json'),
  'chat-step-place': require('@/assets/animations/chat-step-place.json'),
  'chat-step-write': require('@/assets/animations/chat-step-write.json'),
  'chat-step-remove': require('@/assets/animations/chat-step-remove.json'),
  'chat-step-ask': require('@/assets/animations/chat-step-ask.json'),
  'chat-step-web': require('@/assets/animations/chat-step-web.json'),
};

/**
 * The strips that play once and rest on their LAST frame (progress 1 when
 * motion is off). Every other chat id is a seamless loop resting on frame 0.
 * Mirrored by `ONE_SHOT_IDS` in `scripts/animations/validate.py`.
 */
export const CHAT_ONE_SHOT_IDS = [
  'chat-strip-attest',
  'chat-strip-secure',
  'chat-strip-retry',
  'chat-strip-return',
] as const satisfies readonly ChatStripId[];

/**
 * Where the app lays the real MeraLogo over a cloud strip: the model end, in
 * strip units of a 272 x 32 strip. The Lottie draws nothing inside it.
 */
export const CHAT_STRIP_MARK_BOX = { x: 244.47, y: 1, w: 21.07, h: 30, stripW: 272, stripH: 32 } as const;

/**
 * Where the app lays the MeraLogo on the phone screen of `chat-strip-device`,
 * in strip units of that file's 28 x 32 strip.
 */
export const CHAT_DEVICE_SCREEN_BOX = { x: 7.05, y: 5.1, w: 13.9, h: 19.8, stripW: 28, stripH: 32 } as const;

export function chatStripAnimationFor(
  state: 'phone' | 'attest' | 'secure' | 'think' | 'retry' | 'return' | 'device',
): unknown | null {
  return CHAT_ANIMATIONS[`chat-strip-${state}`] ?? null;
}

export function chatStepAnimationFor(kind: ChatStepKind): unknown | null {
  return CHAT_ANIMATIONS[`chat-step-${kind}`] ?? null;
}
