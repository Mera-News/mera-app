// TUTORIAL_CHAPTERS — the tutorials registry. PURE DATA.
//
// Rules this file lives by:
//   • i18n KEY STRINGS are never written here. Copy is resolved from ids via
//     `lib/tutorials/keys.ts`, so a renamed slide breaks a test instead of
//     rendering a raw key at a user.
//   • No `t()`, no JSX, no React import. `chapters.test.ts` imports this module
//     directly, which is why it can stay fast and hermetic.
//   • Slide ids are unique WITHIN a chapter and are load-bearing: they are half
//     of every i18n key AND half of `animationIdFor()`. Renaming one is a copy
//     migration, not a refactor.
//
// ── Levels ──────────────────────────────────────────────────────────────────
// Basic and advanced are SEPARATE chapters, not dual tracks inside one chapter.
// Seven basics teach the app; five advanced chapters teach the controls, and
// the menu hides them until three basics are done (`lib/tutorials/menu.ts`).
//
// ── Accuracy ────────────────────────────────────────────────────────────────
// Every factual claim in the copy was verified against current source before it
// was written. The load-bearing ones, with where they were checked:
//   • Tabs are icon-only — teach glyphs and positions, never names. Route names
//     are inverted vs the UI (`for_you` = Dashboard, `around` = Explore,
//     `deck` = Feed).
//   • The Feed has NO in-list dividers any more — nothing is ever removed, and a
//     read card SINKS to the bottom of a single unbroken list instead of being
//     cut off by a labelled boundary (`components/custom/feed/feed-entries.ts:1-34`).
//     There used to be two divider cards splicing the list into three visual
//     parts; both were deleted (r14) because their position wasn't reliable —
//     the three tiers (unseen → seen-not-opened → opened) still decide SORT
//     ORDER, they just no longer mark a boundary on screen. The single
//     "All caught up" card (`AllCaughtUpCard`, `feed.allCaughtUp`) survives as
//     the end-of-list footer / empty state, and its CTA switches to "lower the
//     feed priority" when the importance threshold is filtering stories out.
//   • The Feed header is the title, a status glyph and the priority filter, and
//     NOTHING else — no notification bell (it is Dashboard-only), no counts
//     sentence, no progress bar, and its cards carry no timestamp and no NEW
//     badge (`FeedScreen` passes `showRecency={false}`). The Dashboard keeps all
//     of it. The status mark beside the title is the Mera logo and is ALWAYS on
//     screen: it sweeps, grows to 1.3x and turns white while syncing, and rests
//     small and off-white otherwise (red on an error, amber when rate-limited).
//     Tapping it opens a panel that closes itself after 3s, and that tap works
//     in every state, including idle. Chapter `feed` must not teach a bell, a
//     counter or a bar on the Feed, and must not claim a story's age is visible
//     there.
//   • "Read" = opened, or ≥75% on screen for 1.5s
//     (`components/custom/feed/use-visible-index.ts` DWELL_READ_SECONDS = 1.5).
//   • Explore's trailing "+" chip opens `/logged-in/sources`, NOT Locations
//     (`components/custom/explore/ExploreScreen.tsx:52-57`).
//   • Source badges come from `publication_type` and there are exactly two:
//     `government` → "Government source", `regulator` → "Official agency"
//     (`components/custom/config-panel/SourcesL2PublicationList.tsx:55-72`).
//   • On a country, "+" and ↑/↓ are DIFFERENT things: "+" adds an Explore chip
//     and is browse-only (`lib/explore/browse-countries`,
//     `sources.addToExplore`); ↑/↓ change ranking (`SourcePrefControl`).
//   • Mute is a HARD exclusion (weight ≤ −0.9,
//     `lib/mera-protocol/stage-scoring.ts:80`) and lives only on the
//     source-preferences screen; ↓ is only a downrank
//     (`lib/database/services/publication-pref-ui-actions.ts:14-16`).
//   • Structured "not interested" filters match one article field by exact
//     equality, so they are minted from a real article; hand-typed ones are
//     keyword-only (`components/custom/not-interested/AddPhraseModal.tsx:30-35`).
//     Expiry follows STRENGTH, not origin: ≥0.8 ⇒ hard, no expiry; below ⇒ +30d
//     (`lib/database/services/suppression-service.ts:16-19`).
//   • Cloud E2EE is the DEFAULT processing mode; on-device is opt-in
//     (`lib/stores/mera-protocol-store.ts:78`).
//   • There is NO decoy/noise-injection feature. Nothing generates, sends or
//     discards decoy topics, and no setting exists to switch one on, so no
//     chapter may teach one. The privacy and protocol chapters used to, and the
//     slides were removed rather than reworded.
//   • Chapter `teaching` must NOT teach the "Kind of story" / "Person or thing"
//     leaves — article tagging shipped but those kinds match almost nothing.
//   • Chapter `explore` must not borrow relevance phrasing: Explore is
//     genuinely unscored (`ExploreScreen.tsx:47-50` — no suggestions, no
//     scoring, no LLM, nothing persisted).
//
// ── `welcome` is special ────────────────────────────────────────────────────
// It is the PRE-AUTH chapter: no account references, no Ask-Mera, and NO MERA
// LOGO (explicit user instruction). `chapters.test.ts` asserts the logo rule so
// it is not enforced by this comment alone.

import type { ChapterId, TutorialChapter } from './types';

export const TUTORIAL_CHAPTERS: readonly TutorialChapter[] = [
  // ───────────────────────────── 1 · welcome (basic, pre-auth) ─────────────
  {
    id: 'welcome',
    level: 'basic',
    icon: 'auto-awesome',
    slides: [
      {
        id: 'what',
        visual: { placeholder: { kind: 'icon', name: 'newspaper' } },
      },
      {
        id: 'not-a-timeline',
        visual: { placeholder: { kind: 'cards', count: 3 } },
        interaction: {
          kind: 'choose',
          options: [
            { id: 'popular' },
            { id: 'yours', correct: true },
            { id: 'newest' },
          ],
          mustBeCorrect: false,
        },
      },
      {
        id: 'you-first',
        visual: { placeholder: { kind: 'steps', count: 3 } },
      },
      {
        id: 'matching',
        visual: { placeholder: { kind: 'orbit', name: 'person' } },
      },
      {
        id: 'stays-here',
        visual: { placeholder: { kind: 'icon', name: 'phone-iphone' } },
        interaction: {
          kind: 'tap-to-reveal',
          targets: [
            { id: 'about-you', icon: 'lock' },
            { id: 'what-leaves', icon: 'cloud-upload' },
          ],
        },
      },
      {
        id: 'begin',
        visual: { placeholder: { kind: 'icon', name: 'east' } },
      },
    ],
  },

  // ───────────────────────────── 2 · facts (basic) ─────────────────────────
  {
    id: 'facts',
    level: 'basic',
    icon: 'fact-check',
    slides: [
      {
        id: 'a-fact-is',
        visual: { placeholder: { kind: 'icon', name: 'sticky-note-2' } },
        hasAsk: true,
      },
      {
        id: 'where-from',
        visual: { placeholder: { kind: 'steps', count: 3 } },
      },
      {
        id: 'to-topics',
        visual: { placeholder: { kind: 'orbit', name: 'fact-check' } },
      },
      {
        id: 'sort-them',
        visual: { placeholder: { kind: 'cards', count: 4 } },
        interaction: {
          kind: 'sort',
          buckets: [
            { id: 'fact', icon: 'sticky-note-2' },
            { id: 'not-fact', icon: 'block' },
          ],
          cards: [
            { id: 'nurse', bucketId: 'fact' },
            { id: 'utrecht', bucketId: 'fact' },
            { id: 'headline', bucketId: 'not-fact' },
            { id: 'mood', bucketId: 'not-fact' },
          ],
        },
      },
      {
        id: 'importance',
        visual: { placeholder: { kind: 'icon', name: 'tune' } },
        hasAsk: true,
      },
    ],
  },

  // ───────────────────────────── 3 · feed (basic) ──────────────────────────
  {
    id: 'feed',
    level: 'basic',
    icon: 'view-agenda',
    slides: [
      {
        id: 'two-lists',
        visual: { placeholder: { kind: 'cards', count: 3 } },
        hasAsk: true,
      },
      {
        id: 'nothing-removed',
        visual: { placeholder: { kind: 'steps', count: 3 } },
        interaction: { kind: 'before-after', requiredToggles: 1 },
      },
      {
        id: 'what-counts-as-read',
        visual: { placeholder: { kind: 'icon', name: 'timer' } },
        interaction: {
          kind: 'tap-to-reveal',
          targets: [
            { id: 'open', icon: 'open-in-new' },
            { id: 'dwell', icon: 'hourglass-bottom' },
            { id: 'act', icon: 'thumb-up' },
          ],
          requiredReveals: 2,
        },
      },
      {
        id: 'order-holds-still',
        visual: { placeholder: { kind: 'icon', name: 'lock-clock' } },
      },
      {
        id: 'why-this-one',
        visual: { placeholder: { kind: 'cards', count: 2 } },
        hasAsk: true,
      },
      {
        id: 'quiet-by-design',
        visual: { placeholder: { kind: 'icon', name: 'spa' } },
        interaction: {
          kind: 'tap-to-reveal',
          targets: [
            { id: 'feed', icon: 'view-agenda' },
            { id: 'dashboard', icon: 'grid-view' },
          ],
        },
        hasAsk: true,
      },
      {
        id: 'caught-up',
        visual: { placeholder: { kind: 'icon', name: 'check-circle' } },
      },
    ],
  },

  // ───────────────────────────── 4 · teaching (basic) ──────────────────────
  {
    id: 'teaching',
    level: 'basic',
    icon: 'thumbs-up-down',
    slides: [
      {
        id: 'two-thumbs',
        visual: { placeholder: { kind: 'icon', name: 'thumbs-up-down' } },
      },
      {
        id: 'bare-thumb',
        visual: { placeholder: { kind: 'steps', count: 3 } },
        hasAsk: true,
      },
      {
        id: 'the-reason',
        visual: { placeholder: { kind: 'cards', count: 2 } },
        interaction: {
          kind: 'choose',
          options: [
            { id: 'just-thumb' },
            { id: 'thumb-plus-reason', correct: true },
          ],
          mustBeCorrect: true,
        },
      },
      {
        id: 'undo',
        visual: { placeholder: { kind: 'icon', name: 'undo' } },
      },
      {
        id: 'it-adds-up',
        visual: { placeholder: { kind: 'orbit', name: 'thumb-up' } },
        hasAsk: true,
      },
    ],
  },

  // ───────────────────────────── 5 · privacy (basic) ───────────────────────
  {
    id: 'privacy',
    level: 'basic',
    icon: 'lock',
    slides: [
      {
        id: 'stays-on-phone',
        visual: { placeholder: { kind: 'icon', name: 'phone-iphone' } },
      },
      {
        id: 'what-leaves',
        visual: { placeholder: { kind: 'steps', count: 3 } },
        hasAsk: true,
      },
      {
        id: 'cloud-is-default',
        visual: { placeholder: { kind: 'icon', name: 'cloud-done' } },
        interaction: { kind: 'before-after', requiredToggles: 1 },
      },
      {
        id: 'on-device-option',
        visual: { placeholder: { kind: 'icon', name: 'memory' } },
      },
      {
        id: 'what-we-keep',
        visual: { placeholder: { kind: 'cards', count: 3 } },
        hasAsk: true,
      },
    ],
  },

  // ───────────────────────────── 6 · following (basic) ─────────────────────
  {
    id: 'following',
    level: 'basic',
    icon: 'track-changes',
    slides: [
      {
        id: 'what-it-is',
        visual: { placeholder: { kind: 'icon', name: 'track-changes' } },
      },
      {
        id: 'two-ways-in',
        visual: { placeholder: { kind: 'steps', count: 2 } },
        hasAsk: true,
      },
      {
        id: 'pick-the-scope',
        visual: { placeholder: { kind: 'cards', count: 3 } },
        interaction: {
          kind: 'choose',
          options: [
            { id: 'narrow' },
            { id: 'medium' },
            { id: 'wide' },
          ],
          mustBeCorrect: false,
        },
      },
      {
        id: 'the-timeline',
        visual: { placeholder: { kind: 'orbit', name: 'timeline' } },
      },
      {
        id: 'stop-following',
        visual: { placeholder: { kind: 'icon', name: 'notifications-off' } },
        hasAsk: true,
      },
    ],
  },

  // ───────────────────────────── 7 · explore (basic) ───────────────────────
  {
    id: 'explore',
    level: 'basic',
    icon: 'explore',
    slides: [
      {
        id: 'unscored-on-purpose',
        visual: { placeholder: { kind: 'icon', name: 'public' } },
        hasAsk: true,
      },
      {
        id: 'the-chips',
        visual: { placeholder: { kind: 'steps', count: 2 } },
      },
      {
        id: 'the-plus-chip',
        visual: { placeholder: { kind: 'icon', name: 'add-circle-outline' } },
        interaction: {
          kind: 'choose',
          options: [
            { id: 'places' },
            { id: 'sources', correct: true },
            { id: 'settings' },
          ],
          mustBeCorrect: true,
        },
      },
      {
        id: 'search',
        visual: { placeholder: { kind: 'icon', name: 'search' } },
      },
      {
        id: 'hide-a-chip',
        visual: { placeholder: { kind: 'cards', count: 3 } },
        hasAsk: true,
      },
    ],
  },

  // ───────────────────────────── 8 · sources (advanced) ────────────────────
  {
    id: 'sources',
    level: 'advanced',
    icon: 'newspaper',
    slides: [
      {
        id: 'where-it-lives',
        visual: { placeholder: { kind: 'steps', count: 2 } },
        hasAsk: true,
      },
      {
        id: 'the-two-badges',
        visual: { placeholder: { kind: 'icon', name: 'verified' } },
        interaction: {
          kind: 'tap-to-reveal',
          targets: [
            { id: 'government', icon: 'account-balance' },
            { id: 'regulator', icon: 'gavel' },
            { id: 'everything-else', icon: 'newspaper' },
          ],
        },
      },
      {
        id: 'plus-is-not-a-rank',
        visual: { placeholder: { kind: 'icon', name: 'add-circle-outline' } },
        interaction: {
          kind: 'choose',
          options: [
            { id: 'ranks-it-up' },
            { id: 'adds-a-chip', correct: true },
            { id: 'follows-it' },
          ],
          mustBeCorrect: true,
        },
      },
      {
        id: 'arrows-on-a-country',
        visual: { placeholder: { kind: 'orbit', name: 'flag' } },
      },
      {
        id: 'arrows-on-a-publisher',
        visual: { placeholder: { kind: 'cards', count: 3 } },
        hasAsk: true,
      },
      {
        id: 'mute-is-not-a-downrank',
        visual: { placeholder: { kind: 'steps', count: 3 } },
        interaction: {
          kind: 'sort',
          buckets: [
            { id: 'softer', icon: 'arrow-downward' },
            { id: 'gone', icon: 'block' },
          ],
          cards: [
            { id: 'down-arrow', bucketId: 'softer' },
            { id: 'mute', bucketId: 'gone' },
          ],
        },
      },
    ],
  },

  // ───────────────────────────── 9 · filters (advanced) ────────────────────
  {
    id: 'filters',
    level: 'advanced',
    icon: 'filter-alt',
    slides: [
      {
        id: 'three-shelves',
        visual: { placeholder: { kind: 'steps', count: 3 } },
        hasAsk: true,
      },
      {
        id: 'exact-match',
        visual: { placeholder: { kind: 'icon', name: 'my-location' } },
      },
      {
        id: 'made-from-a-story',
        visual: { placeholder: { kind: 'cards', count: 2 } },
        interaction: {
          kind: 'choose',
          options: [
            { id: 'type-it' },
            { id: 'from-an-article', correct: true },
          ],
          mustBeCorrect: true,
        },
      },
      {
        id: 'typed-is-words-only',
        visual: { placeholder: { kind: 'icon', name: 'keyboard' } },
      },
      {
        id: 'soft-fades-hard-stays',
        visual: { placeholder: { kind: 'icon', name: 'hourglass-bottom' } },
        interaction: { kind: 'before-after', requiredToggles: 1 },
        hasAsk: true,
      },
    ],
  },

  // ───────────────────────────── 10 · signal (advanced) ────────────────────
  {
    id: 'signal',
    level: 'advanced',
    icon: 'tune',
    slides: [
      {
        id: 'the-dial',
        visual: { placeholder: { kind: 'icon', name: 'tune' } },
        hasAsk: true,
      },
      {
        id: 'per-screen',
        visual: { placeholder: { kind: 'steps', count: 2 } },
        interaction: {
          kind: 'sort',
          buckets: [
            { id: 'feed-tab', icon: 'view-agenda' },
            { id: 'dashboard-tab', icon: 'grid-view' },
          ],
          cards: [
            { id: 'medium-default', bucketId: 'feed-tab' },
            { id: 'low-default', bucketId: 'dashboard-tab' },
          ],
        },
      },
      {
        id: 'breaking-always-passes',
        visual: { placeholder: { kind: 'icon', name: 'priority-high' } },
      },
      {
        id: 'headline-cull',
        visual: { placeholder: { kind: 'cards', count: 3 } },
        hasAsk: true,
      },
    ],
  },

  // ───────────────────────────── 11 · chat (advanced) ──────────────────────
  {
    id: 'chat',
    level: 'advanced',
    icon: 'forum',
    slides: [
      {
        id: 'where-mera-is',
        visual: { placeholder: { kind: 'logo' } },
        hasAsk: true,
      },
      {
        id: 'ask-what-it-knows',
        visual: { placeholder: { kind: 'icon', name: 'help-outline' } },
      },
      {
        id: 'say-it-plainly',
        visual: { placeholder: { kind: 'steps', count: 3 } },
        interaction: {
          kind: 'tap-to-reveal',
          targets: [
            { id: 'less-of', icon: 'volume-off' },
            { id: 'more-of', icon: 'add' },
            { id: 'moved', icon: 'place' },
          ],
          requiredReveals: 2,
        },
      },
      {
        id: 'nothing-until-you-tap',
        visual: { placeholder: { kind: 'cards', count: 2 } },
        interaction: {
          kind: 'choose',
          options: [
            { id: 'applies-immediately' },
            { id: 'waits-for-your-tap', correct: true },
          ],
          mustBeCorrect: true,
        },
        hasAsk: true,
      },
      {
        id: 'written-down',
        visual: { placeholder: { kind: 'icon', name: 'receipt-long' } },
      },
      {
        id: 'take-it-back',
        visual: { placeholder: { kind: 'icon', name: 'undo' } },
        interaction: { kind: 'before-after', requiredToggles: 1 },
        hasAsk: true,
      },
    ],
  },

  // ───────────────────────────── 12 · protocol (advanced) ──────────────────
  {
    id: 'protocol',
    level: 'advanced',
    icon: 'security',
    slides: [
      {
        id: 'one-screen',
        visual: { placeholder: { kind: 'steps', count: 2 } },
        hasAsk: true,
      },
      {
        id: 'processing-mode',
        visual: { placeholder: { kind: 'icon', name: 'cloud-done' } },
        interaction: {
          kind: 'tap-to-reveal',
          targets: [
            { id: 'cloud', icon: 'cloud-done' },
            { id: 'on-device', icon: 'memory' },
          ],
        },
      },
      {
        id: 'deeper-questions',
        visual: { placeholder: { kind: 'icon', name: 'psychology' } },
      },
      // The noise-injection layer (Mera Protocol Rules 2/3/5) is being built and
      // does NOT ship today: nothing generates, sends or discards a decoy topic,
      // and there is no setting to switch one on. The slide stays because the
      // owner is actively working on it, but its copy must describe it as
      // unbuilt. `chapters.test.ts` enforces exactly that — it is the one
      // allowlisted mention, and it fails if the copy stops saying so.
      {
        id: 'inject-noise',
        visual: { placeholder: { kind: 'orbit', name: 'blur-on' } },
      },
      {
        id: 'web-search',
        visual: { placeholder: { kind: 'icon', name: 'travel-explore' } },
        interaction: {
          kind: 'choose',
          options: [
            { id: 'whole-question' },
            { id: 'search-words-only', correct: true },
          ],
          mustBeCorrect: true,
        },
        hasAsk: true,
      },
      {
        id: 'the-change-log',
        visual: { placeholder: { kind: 'icon', name: 'receipt-long' } },
        hasAsk: true,
      },
    ],
  },
] as const;

/** The pre-auth chapter — the only one playable from the login screen. */
export const PRE_AUTH_CHAPTER_ID: ChapterId = 'welcome';

export function getChapter(id: string): TutorialChapter | undefined {
  return TUTORIAL_CHAPTERS.find((chapter) => chapter.id === id);
}

/** Chapters at one level, in registry order (which is menu order). */
export function chaptersAtLevel(
  level: TutorialChapter['level'],
): readonly TutorialChapter[] {
  return TUTORIAL_CHAPTERS.filter((chapter) => chapter.level === level);
}
