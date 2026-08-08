// The ONLY file in the repo that may hold a tutorial animation `require()`.
//
// ── Why this file exists ────────────────────────────────────────────────────
// Metro resolves `require()` at BUNDLE time. A `try { require(…) } catch {}`
// around a missing animation file is therefore a BUILD error that no runtime
// guard can catch — it is not the same shape as `lib/haptics.ts`, whose guarded
// require works only because `expo-haptics` IS in package.json and the guard is
// protecting against a missing NATIVE side, not a missing module.
//
// So scenes carry an id STRING (see `animationIdFor` in lib/tutorials/keys.ts)
// and this map is the single place a string is turned into a real asset.
//
// ── Current state: EMPTY, deliberately ──────────────────────────────────────
// This wave ships with NO animation runtime at all. There is no
// animation player package in package.json, no pod install, no native rebuild —
// which is the whole point: the tutorials module is OTA-able. Every entry below
// is commented out, and `lib/tutorials/__tests__/chapters.test.ts` mechanically
// asserts that no uncommented line under `components/custom/tutorials/` or
// `lib/tutorials/` mentions an animation package.
//
// `ScenePlaceholder` is therefore the SHIPPED visual layer for all ~65 slides,
// not a stopgap.
//
// ── P6, later, by the user ──────────────────────────────────────────────────
// Turning animations on is a TWO-file change and stays that way at any N from
// 0 to 65:
//   1. Add the player package and re-cut the binary.
//   2. Uncomment the `<AnimationView>` branch in `LottieScene.tsx` (one block,
//      already written out in a comment there) and its import.
//   3. Drop `<chapter>-<slide>.json` into `assets/animations/` and uncomment its
//      line below. An entry may exist here ONLY once its file is on disk.
// Nothing else changes — not the registry, not a chapter, not a key.
//
// Use plain `.json` (already a Metro `sourceExt`), never `.lottie` — that needs
// an `assetExts` change and a dotLottie runtime.

/**
 * `animationIdFor(chapter, slide)` → the required asset module.
 *
 * `unknown` rather than a player-specific source type on purpose: this file must
 * name no animation package, and the consumer casts once at the render site.
 */
export const TUTORIAL_ANIMATIONS: Readonly<Record<string, unknown>> = {
  // 'welcome-what': require('@/assets/animations/welcome-what.json'),
  // 'facts-a-fact-is': require('@/assets/animations/facts-a-fact-is.json'),
  // 'feed-two-lists': require('@/assets/animations/feed-two-lists.json'),
  // 'teaching-two-thumbs': require('@/assets/animations/teaching-two-thumbs.json'),
  // 'privacy-stays-on-phone': require('@/assets/animations/privacy-stays-on-phone.json'),
  // 'following-what-it-is': require('@/assets/animations/following-what-it-is.json'),
  // 'explore-unscored-on-purpose': require('@/assets/animations/explore-unscored-on-purpose.json'),
  // 'sources-where-it-lives': require('@/assets/animations/sources-where-it-lives.json'),
  // 'filters-three-shelves': require('@/assets/animations/filters-three-shelves.json'),
  // 'signal-the-dial': require('@/assets/animations/signal-the-dial.json'),
  // 'chat-where-mera-is': require('@/assets/animations/chat-where-mera-is.json'),
  // 'protocol-one-screen': require('@/assets/animations/protocol-one-screen.json'),
};

/** The asset for an animation id, or `undefined` — which is every id today. */
export function animationSourceFor(id: string | undefined): unknown {
  if (!id) return undefined;
  return TUTORIAL_ANIMATIONS[id];
}
