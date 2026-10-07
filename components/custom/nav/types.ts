// The shell's contract types. Content lanes code against these: each exports
// one page-set component (WorldPages, LibraryPages, YouPages; FeedPages here)
// that renders <TabPages> with its pages and a `renderPage`.

import type { MaterialIcons } from '@expo/vector-icons';
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
  /** Opens the active page's explainer sheet (the ? in its PageTitleRow). */
  readonly openExplainer: () => void;
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
  /** A 14pt glyph before the label (Feed, Stories, World). */
  readonly icon?: keyof typeof MaterialIcons.glyphMap;
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

/** Arranging World's pages (the only tab that arranges): reorder, × per
 *  country, and the add field. */
export interface ArrangeConfig {
  readonly onSave: (draft: ArrangeDraft) => void | Promise<void>;
  readonly search: (query: string) => readonly ArrangeCountryOption[];
  /** The note under the row for a page (place-derived countries), or null. */
  readonly footnoteFor: (id: PageId) => string | null;
  /** World itself is reorderable, never removable. */
  readonly removable: (id: PageId) => boolean;
}

export interface TabPagesProps {
  readonly tab: TabId;
  /** Ordered. Keys are page ids, so a reorder or a World add/remove never
   *  remounts a page that stays. */
  readonly pages: readonly PagePill[];
  readonly renderPage: (props: PageRenderProps) => React.ReactNode;
  /** World: the floating search button at the strip's end. */
  readonly onSearch?: () => void;
  /** World: a long press on a page name opens the overlay. Absent: fixed pages. */
  readonly arrange?: ArrangeConfig;
  /** Drawn at the header row's start (the Feed's status icon). */
  readonly leading?: React.ReactNode;
  readonly testID?: string;
}
