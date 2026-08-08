// The tutorials contract. PURE data types — no JSX, no React, no i18n calls.
//
// Lives in `lib/` rather than under `components/custom/tutorials/` for two
// reasons: the registry is data that the jest coverage gate can actually cover,
// and `chapters.test.ts` can then import the registry and the key derivation
// without dragging a component tree (and Reanimated) into the suite.
//
// ── The animation seam ──────────────────────────────────────────────────────
// A scene carries an `animation` ID STRING, never a `require()`. Metro resolves
// `require()` at BUNDLE time, so a `try/catch` around a missing animation file
// is a build error no runtime guard can catch. Exactly one file in the repo may
// hold animation requires: `components/custom/tutorials/animation-registry.ts`.
//
// This wave ships with NO animation runtime at all — no `lottie-react-native`
// in package.json, so the string `lottie-react-native` must not appear in any
// uncommented line under `app/` or `components/`. `chapters.test.ts` enforces
// that mechanically. `ScenePlaceholder` is therefore the SHIPPED visual layer
// for every slide, not a stopgap, and `placeholder` is required, not optional.

import type { MaterialIcons } from '@expo/vector-icons';

/** A Material icon name, as accepted by `<MaterialIcons name=… />`. */
export type MaterialIconName = keyof typeof MaterialIcons.glyphMap;

/** Chapter slugs. Order here is menu order within each level. */
export type ChapterId =
  // level: 'basic'
  | 'welcome'
  | 'facts'
  | 'feed'
  | 'teaching'
  | 'privacy'
  | 'following'
  | 'explore'
  // level: 'advanced'
  | 'sources'
  | 'filters'
  | 'signal'
  | 'chat'
  | 'protocol';

/**
 * Basic and advanced are SEPARATE chapters, not two tracks inside one chapter.
 * The menu renders them as two sections ("Start here" / "Go deeper"), and the
 * advanced section is gated behind `ADVANCED_UNLOCK_THRESHOLD` completed basics
 * (see `lib/tutorials/menu.ts`).
 */
export type ChapterLevel = 'basic' | 'advanced';

/**
 * `<chapter>-<slide>` — the filename an animation would ship under, and the key
 * `animation-registry.ts` looks up. Derived, never hand-written: see
 * `animationIdFor()` in `lib/tutorials/keys.ts`.
 */
export type AnimationId = string;

/**
 * The shipped visual layer. FIVE kinds, deliberately: twelve chapters on four
 * kinds reads as repetitive where seven on four did not.
 *
 * ⚠️ `reactCompiler: true` is on (app.json). NEVER branch on `kind` inside a
 * component that calls `useSharedValue` — one component per kind, dispatched by
 * a hook-free switch. `components/custom/MeraLogo.tsx` documents the same
 * discipline for the same reason.
 */
export type Placeholder =
  /** The animated Mera mark. FORBIDDEN in chapter `welcome` — see chapters.ts. */
  | { readonly kind: 'logo' }
  /** One accent glyph, breathing. */
  | { readonly kind: 'icon'; readonly name: MaterialIconName }
  /** Drifting card skeletons — anything about the feed. */
  | { readonly kind: 'cards'; readonly count?: number }
  /** Dots orbiting a central glyph — anything about "many things around one". */
  | { readonly kind: 'orbit'; readonly name: MaterialIconName }
  /**
   * A vertical run of numbered rows that fill in one after another — the fifth
   * kind, for slides that teach a SEQUENCE (where to tap, then what happens).
   * `count` rows, each labelled from
   * `tutorials.chapters.<slug>.slides.<id>.steps.<n>`.
   */
  | { readonly kind: 'steps'; readonly count: number };

export interface SceneVisual {
  /** Registry lookup id. Absent ⇒ placeholder only, which is every slide today. */
  readonly animation?: AnimationId;
  /** Required: this is what actually renders. */
  readonly placeholder: Placeholder;
  readonly loop?: boolean;
}

/** One tappable target in a `tap-to-reveal` interaction. */
export interface RevealTarget {
  readonly id: string;
  readonly icon: MaterialIconName;
}

/** One option in a `choose` interaction. `correct` drives the reveal, not a score. */
export interface ChoiceOption {
  readonly id: string;
  readonly correct?: boolean;
}

export interface SortCard {
  readonly id: string;
  /** The bucket this card belongs in. */
  readonly bucketId: string;
}

export interface SortBucket {
  readonly id: string;
  readonly icon: MaterialIconName;
}

/**
 * ⚠️ Tap-based only. `GestureDetector` does not receive touches inside an RN
 * `Modal` on Android unless the modal content mounts its own
 * `GestureHandlerRootView` — and the pre-auth host IS a Modal. So `sort` is
 * "tap a card, then tap a bucket", never a drag.
 */
export type Interaction =
  | {
      readonly kind: 'tap-to-reveal';
      readonly targets: readonly RevealTarget[];
      /** Reveals needed to unlock Next. Default: all of them. */
      readonly requiredReveals?: number;
    }
  | {
      readonly kind: 'choose';
      readonly options: readonly ChoiceOption[];
      /** When true, only a `correct` option unlocks. Default false — any answer does. */
      readonly mustBeCorrect?: boolean;
    }
  | {
      readonly kind: 'sort';
      readonly cards: readonly SortCard[];
      readonly buckets: readonly SortBucket[];
    }
  | {
      readonly kind: 'before-after';
      /** Toggles needed to unlock Next. Default 1. */
      readonly requiredToggles?: number;
    };

export interface TutorialSlide {
  /** Unique WITHIN its chapter. Half of the i18n key and of the animation id. */
  readonly id: string;
  readonly visual: SceneVisual;
  readonly interaction?: Interaction;
  /**
   * Show the "Ask Mera" button on this slide. Ignored entirely when the player
   * is mounted with `enableAskMera={false}` (the pre-auth Modal host) — there is
   * no session before login, so there is no agent.
   */
  readonly hasAsk?: boolean;
}

export interface TutorialChapter {
  readonly id: ChapterId;
  readonly level: ChapterLevel;
  readonly icon: MaterialIconName;
  readonly slides: readonly TutorialSlide[];
}
