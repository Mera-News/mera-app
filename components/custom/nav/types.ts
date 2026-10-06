// The shell's contract types. Content lanes code against these: each exports
// one page-set component (WorldPages, LibraryPages, YouPages; FeedPages here)
// that renders <TabPages> with its pages and a `renderPage`.

import type React from 'react';
import type { SharedValue, useAnimatedScrollHandler } from 'react-native-reanimated';

import type { PageId, TabId } from './page-registry';

/** The tab's one collapsing header, handed to every page. Wire
 *  `scrollHandler` to the page's list `onScroll`, pad the list top by
 *  `headerHeight + gap`, and the list end by `useListEndClearance()`. */
export interface PageHeaderBinding {
  readonly scrollHandler: ReturnType<typeof useAnimatedScrollHandler>;
  readonly headerHeight: number;
  readonly hidden: SharedValue<number>;
  readonly reveal: () => void;
}

export interface PageRenderProps {
  readonly pageId: PageId;
  /** The visible page of the focused tab (and its stack's top screen). False
   *  for a warmed neighbour: no scroll ticks, polling, refresh, seen marking
   *  or tab-press handling. */
  readonly active: boolean;
  readonly header: PageHeaderBinding;
  /** One-shot arrival params from `navigateToPage` (Stats: `card`). Non-null
   *  only on the render that lands the request; copy what you need. */
  readonly params: Readonly<Record<string, string>> | null;
}

/** "Something new" on a pill: a dot, never a count. */
export interface PageDot {
  readonly visible: boolean;
}

export interface PagePill {
  readonly id: PageId;
  /** Resolved label (a country page passes the country name). */
  readonly label: string;
  /** Flag on a country pill; hidden from accessibility (the label names it). */
  readonly flagAlpha2?: string;
  /** Called inside a per-pill component keyed by `id`, so reordering never
   *  changes hook order. Must be a hook (named use...). */
  readonly useDot?: () => PageDot;
}

/** What ✓ commits. Nothing is written before it; ✕ discards all three. */
export interface ArrangeDraft {
  readonly order: readonly PageId[];
  readonly removed: readonly PageId[];
  /** ISO alpha-2 codes added in the overlay. */
  readonly added: readonly string[];
}

export interface ArrangeCountryOption {
  readonly alpha2: string;
  readonly name: string;
}

/** World only: × per country and the add field. */
export interface ArrangeWorldVariant {
  readonly search: (query: string) => readonly ArrangeCountryOption[];
  /** The note under the row for a page (place-derived countries), or null. */
  readonly footnoteFor: (id: PageId) => string | null;
  /** World itself is reorderable, never removable. */
  readonly removable: (id: PageId) => boolean;
}

export interface ArrangeConfig {
  readonly onSave: (draft: ArrangeDraft) => void | Promise<void>;
  /** The pen was tapped (World marks its intro line done). */
  readonly onOpen?: () => void;
  readonly world?: ArrangeWorldVariant;
}

export type TabTrailing = 'bell' | { readonly kind: 'search'; readonly onPress: () => void };

export interface TabPagesProps {
  readonly tab: TabId;
  /** Ordered. Keys are page ids, so a reorder or a World add/remove never
   *  remounts a page that stays. */
  readonly pages: readonly PagePill[];
  readonly renderPage: (props: PageRenderProps) => React.ReactNode;
  readonly trailing: TabTrailing;
  readonly arrange: ArrangeConfig;
  readonly testID?: string;
}

/** For a horizontal RNGH scroller inside a page (the Stats pager): give it
 *  `ref`, and report its edges so the page swipe takes over at the edge in
 *  the swipe direction (one continuous swipe from Stats to You). */
export interface SwipeBlocker {
  readonly ref: React.RefObject<any>;
  readonly setEdge: (edge: { readonly start: boolean; readonly end: boolean }) => void;
}
