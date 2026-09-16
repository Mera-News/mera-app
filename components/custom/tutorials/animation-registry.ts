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
 * Two families, one map, and the second one is NOT derived.
 *
 * Chapter heroes are keyed by `animationIdFor(chapter, slide)`. The seven
 * `tutorial-hint-*` gesture loops are not slides, so there is no chapter and no
 * slide to derive from. They carry EXPLICIT ids, listed in
 * `EXPLICIT_ANIMATION_IDS` below.
 *
 * That is a deliberate choice against extending `animationIdFor`: a derivation
 * that has to special-case a family is not a derivation any more, it is a
 * lookup table with extra steps, and the next author would have to read the
 * function to find out which ids are real.
 *
 * ── The hint loops have no renderer on this branch ──────────────────────────
 * There are no gesture mechanics here, so nothing resolves a hint id today.
 * They are claimed, resolvable assets and nothing more, which is a supported
 * state: the entry is what stops the orphan gate reading the file as a stray,
 * and it costs one `require()` each. The mechanic-kind → id resolver that
 * belongs beside them is deliberately absent, because "mechanic kind" has no
 * definition on this branch and a resolver over a domain that does not exist
 * would be a claim about a system nobody built.
 *
 * ── The `game-` prefix means it is NOT this registry's ──────────────────────
 * A `game-` piece belongs to `components/custom/game-ui/animation-registry.ts`.
 * Two registries holding a `require()` for one file is two homes for one thing,
 * which is how a missing asset becomes a build failure nobody can guard. Only
 * `tutorial-` and derived hero ids belong here.
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

  // ── Gesture hint loops, explicit ids ───────────────────────────────────────
  // One looping hint per mechanic kind. A loop SHOWS a gesture instead of
  // describing it, which is why there is one per kind rather than one generic
  // "drag something" loop. Nothing on this branch renders them yet.
  'tutorial-hint-sweep': require('@/assets/animations/tutorial-hint-sweep.json'),
  'tutorial-hint-sortdrag': require('@/assets/animations/tutorial-hint-sortdrag.json'),
  'tutorial-hint-hold': require('@/assets/animations/tutorial-hint-hold.json'),
  'tutorial-hint-swipe': require('@/assets/animations/tutorial-hint-swipe.json'),
  'tutorial-hint-pullout': require('@/assets/animations/tutorial-hint-pullout.json'),
  'tutorial-hint-flick': require('@/assets/animations/tutorial-hint-flick.json'),
  'tutorial-hint-dragline': require('@/assets/animations/tutorial-hint-dragline.json'),
};

/**
 * Ids that are NOT slide heroes, so nothing tries to derive them.
 *
 * The asset gate filters the map by this list before asserting one hero per
 * chapter. Counting the whole map instead would mean editing the count every
 * time a non-hero piece lands, which is how a count assertion stops meaning
 * anything.
 */
export const EXPLICIT_ANIMATION_IDS = [
  'tutorial-hint-sweep',
  'tutorial-hint-sortdrag',
  'tutorial-hint-hold',
  'tutorial-hint-swipe',
  'tutorial-hint-pullout',
  'tutorial-hint-flick',
  'tutorial-hint-dragline',
] as const;

/** The asset for an animation id, or `undefined` for a slide without one. */
export function animationSourceFor(id: string | undefined): unknown {
  if (!id) return undefined;
  return TUTORIAL_ANIMATIONS[id];
}
