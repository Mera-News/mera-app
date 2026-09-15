// The ONLY file in the repo that may hold a tutorial animation `require()`.
//
// ── Why this file exists ────────────────────────────────────────────────────
// Metro resolves `require()` at BUNDLE time. A `try { require(…) } catch {}`
// around a missing animation file is therefore a BUILD error that no runtime
// guard can catch — it is not the same shape as `lib/haptics.ts`, whose guarded
// require works only because `expo-haptics` IS in package.json and the guard is
// protecting against a missing NATIVE side, not a missing module.
//
// So scenes carry an id STRING and this map is the single place a string is
// turned into a real asset. **An entry may exist here only once its file is on
// disk.**
//
// ── Where the id comes from ─────────────────────────────────────────────────
// `animationIdFor(chapter, slide)` in `lib/tutorials/keys.ts`, computed by
// `SlideView` and handed to `SceneView`. It is DERIVED, so `chapters.ts` has no
// `animation` field on any slide and turning a hero on never touches a chapter.
//
// ── Adding one ──────────────────────────────────────────────────────────────
//   1. Drop `<chapter>-<slide>.json` into `assets/animations/` — it has to meet
//      that directory's contract, and its README says how to check.
//   2. Uncomment its line below.
// Nothing else changes, at any N from 0 to 65. A slide with no entry keeps its
// `ScenePlaceholder`, which is the shipped visual layer for the ~53 slides that
// are not chapter heroes, not a stopgap. The two coexist indefinitely.
//
// Use plain `.json` (already a Metro `sourceExt`), never `.lottie` — that needs
// an `assetExts` change and a dotLottie runtime.
//
// ── The runtime is in the binary ────────────────────────────────────────────
// `lottie-react-native ~7.3.4` was banked in `baff527`, an ancestor of the
// 1.3.1 version bump, so every 1.3.1 binary carries the native module and this
// whole map ships over the air. `lib/tutorials/__tests__/chapters.test.ts`
// asserts the dependency STAYS, which is the thing that would silently re-break
// this if it were dropped.

/**
 * `animationIdFor(chapter, slide)` → the required asset module.
 *
 * `unknown` rather than a player-specific source type on purpose: the consumer
 * casts once at the render site, so swapping the player later is one file.
 */
export const TUTORIAL_ANIMATIONS: Readonly<Record<string, unknown>> = {
  'welcome-what': require('@/assets/animations/welcome-what.json'),
  'facts-a-fact-is': require('@/assets/animations/facts-a-fact-is.json'),
  'feed-two-lists': require('@/assets/animations/feed-two-lists.json'),
  'teaching-two-thumbs': require('@/assets/animations/teaching-two-thumbs.json'),
  'privacy-stays-on-phone': require('@/assets/animations/privacy-stays-on-phone.json'),
  'following-what-it-is': require('@/assets/animations/following-what-it-is.json'),
  'explore-unscored-on-purpose': require('@/assets/animations/explore-unscored-on-purpose.json'),
  'sources-where-it-lives': require('@/assets/animations/sources-where-it-lives.json'),
  'filters-three-shelves': require('@/assets/animations/filters-three-shelves.json'),
  'signal-the-dial': require('@/assets/animations/signal-the-dial.json'),
  'chat-where-mera-is': require('@/assets/animations/chat-where-mera-is.json'),
  'protocol-one-screen': require('@/assets/animations/protocol-one-screen.json'),
};

/** The asset for an animation id, or `undefined` for a slide without one. */
export function animationSourceFor(id: string | undefined): unknown {
  if (!id) return undefined;
  return TUTORIAL_ANIMATIONS[id];
}
