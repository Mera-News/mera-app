// The four-tab shell's page table: which tab each page lives in, its pill
// label and what the ? beside its title explains.
//
// RN-free and i18n-free on purpose: the Mera button, the startup gate and
// several stores read it, and none of them may pull a component graph (or the
// SQLite singleton) into their suites. Labels are i18n KEYS, resolved by the
// caller.
//
// Ids and default orders live in lib/navigation/page-order.ts (lib must not
// import components); this file re-exports them so shell code has one import.
//
// Page ids are stable strings used everywhere (order rows, hints, focus):
// feed, interests, stories, world, country:<ALPHA2>, saved, checks, visited,
// stats, profile, settings, notifications. A country page id is ALWAYS alpha-2; the explore
// scope ids stay `country:<ALPHA3>` and only lib/explore/world-pages.ts
// converts between the two.

import type { ParseKeys } from 'i18next';

import type { ChapterId } from '@/lib/tutorials/types';

import {
  DEFAULT_PAGE_ORDER,
  type CountryPageId,
  type PageId,
  type StaticPageId,
  type StaticTabId,
  type TabId,
} from '@/lib/navigation/page-order';

export { DEFAULT_PAGE_ORDER };
export type { CountryPageId, PageId, StaticPageId, StaticTabId, TabId };

/** Bottom-tab order. Also the cross-tab swipe order. */
export const TAB_ORDER: readonly TabId[] = ['feed', 'world', 'library', 'you'];

/** A key of the app's typed dictionary (typed off en.json), so pages can
 *  `t(meta.labelKey)` with no cast. */
export type I18nKey = ParseKeys;

/** Every page id that is not a country page. */
export type FixedPageId = StaticPageId | 'world';

export interface PageExplainer {
  readonly titleKey: I18nKey;
  readonly paragraphKeys: readonly I18nKey[];
  /** The tutorial chapter Learn more opens (`openTutorial`). */
  readonly chapter: ChapterId;
  /** The card in that chapter; absent: its first. */
  readonly slide?: string;
}

export interface PageMeta {
  readonly tab: TabId;
  /** i18n key of the pill label. Country pages are labelled by country name. */
  readonly labelKey: I18nKey;
  /** Never unmounted by the pager window. Feed only: its reading session
   *  (pinned prefix, partition snapshot, row session) lives in the screen. */
  readonly keepMounted: boolean;
  /** What the ? beside the page's title opens. Null: the board draws no ?
   *  there (Settings, Notifications). */
  readonly explainer: PageExplainer | null;
}

export const PAGE_META: Readonly<Record<FixedPageId, PageMeta>> = {
  feed: {
    tab: 'feed',
    labelKey: 'tabs.deck',
    keepMounted: true,
    explainer: {
      titleKey: 'feed.forYouTitle',
      paragraphKeys: ['explainer.feed.p1', 'explainer.feed.p2', 'tabExplainer.feed.privacy'],
      chapter: 'feed',
    },
  },
  interests: {
    tab: 'feed',
    labelKey: 'nav.page.interests',
    keepMounted: false,
    explainer: {
      titleKey: 'tabExplainer.interests.title',
      paragraphKeys: [
        'tabExplainer.interests.what',
        'tabExplainer.forYou.how1',
        'tabExplainer.interests.how2',
        'tabExplainer.interests.how3',
      ],
      chapter: 'feed',
      slide: 'two-lists',
    },
  },
  stories: {
    tab: 'feed',
    labelKey: 'nav.page.stories',
    keepMounted: false,
    explainer: {
      titleKey: 'trackedStories.title',
      paragraphKeys: ['explainer.stories.p1', 'explainer.stories.p2', 'tabExplainer.stories.privacy'],
      chapter: 'following',
    },
  },
  world: {
    tab: 'world',
    labelKey: 'tabs.world',
    keepMounted: false,
    explainer: {
      titleKey: 'sources.topHeadlines',
      paragraphKeys: ['world.explainer.top1', 'world.explainer.window', 'world.explainer.same'],
      chapter: 'explore',
    },
  },
  saved: {
    tab: 'library',
    labelKey: 'nav.page.saved',
    keepMounted: false,
    explainer: {
      titleKey: 'library.explainer.saved.title',
      paragraphKeys: ['library.explainer.saved.what', 'library.explainer.saved.how1', 'library.explainer.saved.how2'],
      chapter: 'library',
      slide: 'saved',
    },
  },
  checks: {
    tab: 'library',
    labelKey: 'factCheck.dashboard.listTitle',
    keepMounted: false,
    explainer: {
      titleKey: 'library.explainer.checks.title',
      paragraphKeys: ['library.explainer.checks.what', 'library.explainer.checks.how1', 'library.explainer.checks.how2'],
      chapter: 'library',
      slide: 'fact-checks',
    },
  },
  visited: {
    tab: 'library',
    labelKey: 'publicationPage.history',
    keepMounted: false,
    explainer: {
      titleKey: 'library.explainer.visited.title',
      paragraphKeys: [
        'library.explainer.visited.what',
        'library.explainer.visited.how1',
        'library.explainer.visited.how2',
        'library.explainer.visited.privacy',
      ],
      chapter: 'library',
      slide: 'history',
    },
  },
  stats: {
    tab: 'library',
    labelKey: 'nav.page.stats',
    keepMounted: false,
    explainer: {
      titleKey: 'library.explainer.stats.title',
      paragraphKeys: ['library.explainer.stats.what', 'library.explainer.stats.how1', 'library.explainer.stats.how2'],
      chapter: 'library',
      slide: 'stats',
    },
  },
  profile: {
    tab: 'you',
    labelKey: 'tabs.profile',
    keepMounted: false,
    explainer: {
      titleKey: 'you.explainer.title',
      paragraphKeys: ['you.explainer.what', 'you.explainer.how1', 'you.explainer.privacy'],
      chapter: 'facts',
      slide: 'your-profile',
    },
  },
  settings: { tab: 'you', labelKey: 'tabs.settings', keepMounted: false, explainer: null },
  // The inbox (NotificationsScreen embedded). Not `settings:notifications`,
  // which is the notification SETTINGS screen pushed in the You stack.
  notifications: { tab: 'you', labelKey: 'notificationCenter.title', keepMounted: false, explainer: null },
};

/** A country page: World's shape, its own explainer. */
const COUNTRY_PAGE_META: PageMeta = {
  ...PAGE_META.world,
  explainer: {
    titleKey: 'sources.topHeadlines',
    paragraphKeys: ['world.explainer.country1', 'world.explainer.window', 'world.explainer.countrySame'],
    chapter: 'explore',
  },
};

/** Tab-bar labels (also the cross-tab edge label). */
export const TAB_LABEL_KEYS: Readonly<Record<TabId, I18nKey>> = {
  feed: 'tabs.deck',
  world: 'tabs.world',
  library: 'tabs.library',
  you: 'tabs.you',
};

const COUNTRY_PREFIX = 'country:';

export function isCountryPage(id: string): id is CountryPageId {
  return id.startsWith(COUNTRY_PREFIX) && id.length > COUNTRY_PREFIX.length;
}

/** `country:DE` from `de` or `DE`. */
export function countryPageId(alpha2: string): CountryPageId {
  return `${COUNTRY_PREFIX}${alpha2.toUpperCase()}`;
}

/** `DE` from `country:DE`, or null for any other page. */
export function alpha2OfPage(id: string): string | null {
  return isCountryPage(id) ? id.slice(COUNTRY_PREFIX.length) : null;
}

/** Meta for a page; a country page has World's shape and its own explainer. */
export function pageMeta(id: PageId): PageMeta {
  return isCountryPage(id) ? COUNTRY_PAGE_META : PAGE_META[id as FixedPageId];
}

export function tabOfPage(id: PageId): TabId {
  return pageMeta(id).tab;
}

/**
 * What the reader is looking at, for the Mera button (hint pool, chat
 * context, visibility) and the jump-origin Back. A superset of PageId: the
 * pushed screens inside a tab's stack, and Search (a root push).
 */
export type SurfaceId =
  | PageId
  | `interest:${string}`
  | 'facts'
  | 'locations'
  | 'sources'
  | 'hygiene'
  | 'not-interested'
  | 'activity'
  | 'settings:display'
  | 'settings:mera-protocol'
  | 'settings:notifications'
  | 'search';

const YOU_STACK_SURFACES: ReadonlySet<string> = new Set([
  'facts',
  'locations',
  'sources',
  'hygiene',
  'not-interested',
  'activity',
  'settings:display',
  'settings:mera-protocol',
  'settings:notifications',
]);

/** The tab a surface lives in, or null for a root push (Search). */
export function tabForSurface(surface: SurfaceId): TabId | null {
  if (surface === 'search') return null;
  if (surface.startsWith('interest:')) return 'feed';
  if (YOU_STACK_SURFACES.has(surface)) return 'you';
  return tabOfPage(surface as PageId);
}

/** The route of a tab's root. */
export function tabRoute(tab: TabId): `/logged-in/app_container/${TabId}` {
  return `/logged-in/app_container/${tab}`;
}
