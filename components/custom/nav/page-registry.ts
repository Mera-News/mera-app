// The four-tab shell's page table: which tab each page lives in, its pill
// label, its quick-settings target and its "How this page works" copy.
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
// stats, profile, settings. A country page id is ALWAYS alpha-2; the explore
// scope ids stay `country:<ALPHA3>` and only lib/explore/world-pages.ts
// converts between the two.

import type { ParseKeys } from 'i18next';

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

/**
 * Focus targets the quick-settings button can jump to. A SUBSET of
 * `FocusId` in lib/navigation/focus-target.ts (L5); kept literal here so this
 * file does not wait on that one. `navigateToSetting` takes it unchanged, so
 * tsc catches any id this list holds that FocusId does not.
 */
export type QuickSettingsFocusId =
  | 'profile.facts'
  | 'profile.places'
  | 'profile.sources'
  | 'profile.topicsDeclined';

export interface PageExplainer {
  readonly titleKey: I18nKey;
  readonly paragraphKeys: readonly I18nKey[];
}

export interface PageMeta {
  readonly tab: TabId;
  /** i18n key of the pill label. Country pages are labelled by country name. */
  readonly labelKey: I18nKey;
  /** Where the bolt-badged sliders button jumps. Null: no button on this page. */
  readonly quickSettings: readonly QuickSettingsFocusId[] | null;
  /** Never unmounted by the pager window. Feed only: its reading session
   *  (pinned prefix, partition snapshot, row session) lives in the screen. */
  readonly keepMounted: boolean;
  /** The "How this page works" row's copy. Null: no row (Settings). */
  readonly explainer: PageExplainer | null;
}

const SHAPING_TARGETS: readonly QuickSettingsFocusId[] = [
  'profile.facts',
  'profile.places',
  'profile.sources',
  'profile.topicsDeclined',
];

/** Filled in per lane as each content lane hands over its explainer keys. */
export const PAGE_META: Readonly<Record<FixedPageId, PageMeta>> = {
  feed: {
    tab: 'feed',
    labelKey: 'tabs.deck',
    quickSettings: SHAPING_TARGETS,
    keepMounted: true,
    explainer: {
      titleKey: 'tabExplainer.feed.title',
      paragraphKeys: [
        'tabExplainer.feed.what',
        'tabExplainer.feed.how1',
        'tabExplainer.feed.how2',
        'tabExplainer.feed.how3',
        'tabExplainer.feed.privacy',
      ],
    },
  },
  interests: {
    tab: 'feed',
    labelKey: 'nav.page.interests',
    quickSettings: SHAPING_TARGETS,
    keepMounted: false,
    explainer: {
      titleKey: 'tabExplainer.interests.title',
      paragraphKeys: [
        'tabExplainer.interests.what',
        'tabExplainer.forYou.how1',
        'tabExplainer.interests.how2',
        'tabExplainer.interests.how3',
      ],
    },
  },
  stories: {
    tab: 'feed',
    labelKey: 'nav.page.stories',
    quickSettings: null,
    keepMounted: false,
    explainer: {
      titleKey: 'tabExplainer.stories.title',
      paragraphKeys: [
        'tabExplainer.stories.what',
        'tabExplainer.stories.how1',
        'tabExplainer.stories.privacy',
      ],
    },
  },
  world: {
    tab: 'world',
    labelKey: 'tabs.world',
    quickSettings: null,
    keepMounted: false,
    explainer: {
      titleKey: 'world.explainer.title',
      paragraphKeys: ['world.explainer.what', 'world.explainer.how1', 'world.explainer.how2'],
    },
  },
  saved: {
    tab: 'library',
    labelKey: 'nav.page.saved',
    quickSettings: null,
    keepMounted: false,
    explainer: {
      titleKey: 'library.explainer.saved.title',
      paragraphKeys: ['library.explainer.saved.what', 'library.explainer.saved.how1', 'library.explainer.saved.how2'],
    },
  },
  checks: {
    tab: 'library',
    labelKey: 'nav.page.checks',
    quickSettings: null,
    keepMounted: false,
    explainer: {
      titleKey: 'library.explainer.checks.title',
      paragraphKeys: ['library.explainer.checks.what', 'library.explainer.checks.how1', 'library.explainer.checks.how2'],
    },
  },
  visited: {
    tab: 'library',
    labelKey: 'nav.page.visited',
    quickSettings: null,
    keepMounted: false,
    explainer: {
      titleKey: 'library.explainer.visited.title',
      paragraphKeys: ['library.explainer.visited.what', 'library.explainer.visited.how1', 'library.explainer.visited.how2', 'library.explainer.visited.privacy'],
    },
  },
  stats: {
    tab: 'library',
    labelKey: 'nav.page.stats',
    quickSettings: null,
    keepMounted: false,
    explainer: {
      titleKey: 'library.explainer.stats.title',
      paragraphKeys: ['library.explainer.stats.what', 'library.explainer.stats.how1', 'library.explainer.stats.how2'],
    },
  },
  profile: {
    tab: 'you',
    labelKey: 'tabs.profile',
    quickSettings: null,
    keepMounted: false,
    explainer: {
      titleKey: 'you.explainer.title',
      paragraphKeys: ['you.explainer.what', 'you.explainer.how1', 'you.explainer.privacy'],
    },
  },
  settings: { tab: 'you', labelKey: 'tabs.settings', quickSettings: null, keepMounted: false, explainer: null },
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

/** Meta for a page; country pages share World's. */
export function pageMeta(id: PageId): PageMeta {
  return isCountryPage(id) ? PAGE_META.world : PAGE_META[id as FixedPageId];
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
