// The resume spot's pure half: what a spot is, which routes it may hold, how it
// is read off a navigation state and how it is checked. No React, no router, no
// database, so the restart marker's parser and every test can load it.
//
// A spot is where the reader is: the tab, the page inside it, every screen
// pushed in that tab's stack and above the tab container, and the scroll of the
// top screen. It is rebuilt after an update reload (`resume-spot.ts`).
//
// The route lists below are an ALLOWLIST. A screen that is not on it makes the
// whole spot null (not restorable), so a new pushed screen is never restorable
// until it is added here with its params.

import type { PageId, TabId } from '@/lib/navigation/page-order';

export const RESUME_SPOT_VERSION = 1;

export interface SpotScreen {
  readonly route: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface SpotScroll {
  /** The top screen's offset, pt. */
  readonly y: number;
  /** Feed only: the row at the top of the viewport. When it is gone after the
   *  reload the Feed lands at its top (its order is per session). */
  readonly anchorId?: string;
  /** How far the anchor row's top sits above the viewport's top, pt. */
  readonly anchorDelta?: number;
}

export interface ResumeSpot {
  readonly v: typeof RESUME_SPOT_VERSION;
  readonly tab: TabId;
  readonly page: PageId | null;
  /** Screens pushed in the tab's stack, bottom to top, its root excluded. */
  readonly tabStack: readonly SpotScreen[];
  /** Screens pushed above the tab container, bottom to top. */
  readonly rootStack: readonly SpotScreen[];
  readonly scroll: SpotScroll | null;
}

interface ParamSchema {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  /** At least one of these must be present. */
  readonly anyOf?: readonly string[];
}

const NO_PARAMS: ParamSchema = { required: [], optional: [] };

/** Screens pushed above `app_container` (app/logged-in/<route>.tsx). */
export const ROOT_ROUTES: Readonly<Record<string, ParamSchema>> = {
  'article-detail': { required: ['articleId'], optional: ['stableClusterId', 'from'] },
  'suggestion-detail': { required: ['articleSuggestionId'], optional: ['from'] },
  publication: { required: [], optional: ['publisherId', 'name', 'country', 'order'], anyOf: ['publisherId', 'name'] },
  'story-timeline': { required: ['trackedStoryId'], optional: [] },
  'persona-articles': { required: ['topicTexts'], optional: ['factStatement'] },
  // Search restores EMPTY: the query is never stored (typed text holds the reload).
  search: NO_PARAMS,
};

/** Screens pushed in a tab's stack (app/logged-in/app_container/<tab>/<route>.tsx).
 *  You's app-lock (PIN setup) and backup (a restore mid-flow) are left out on purpose. */
export const TAB_ROUTES: Readonly<Record<TabId, Readonly<Record<string, ParamSchema>>>> = {
  feed: { interest: { required: ['factId'], optional: ['statement', 'via'] } },
  world: {},
  library: {
    history: { required: [], optional: ['country'] },
    'where-you-read': NO_PARAMS,
    languages: NO_PARAMS,
    'reading-log': { required: [], optional: ['day', 'language'] },
    freshness: NO_PARAMS,
  },
  you: {
    fact: { required: ['factId'], optional: ['statement'] },
    facts: NO_PARAMS,
    sources: NO_PARAMS,
    locations: NO_PARAMS,
    display: NO_PARAMS,
    data: NO_PARAMS,
    activity: NO_PARAMS,
    notifications: NO_PARAMS,
    'mera-protocol': NO_PARAMS,
  },
};

export const TABS: readonly TabId[] = ['feed', 'world', 'library', 'you'];

function isTab(v: unknown): v is TabId {
  return typeof v === 'string' && (TABS as readonly string[]).includes(v);
}

/** The schema's params from `raw`, strings only; null when a required one is missing. */
export function cleanParams(schema: ParamSchema, raw: unknown): Record<string, string> | null {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const k of [...schema.required, ...schema.optional]) {
    const v = src[k];
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  if (schema.required.some((k) => !(k in out))) return null;
  if (schema.anyOf && !schema.anyOf.some((k) => k in out)) return null;
  return out;
}

function cleanScreens(
  list: unknown,
  schemas: Readonly<Record<string, ParamSchema>>,
): SpotScreen[] | null {
  if (!Array.isArray(list)) return null;
  const out: SpotScreen[] = [];
  for (const s of list) {
    const route = (s as { route?: unknown })?.route;
    if (typeof route !== 'string' || !Object.prototype.hasOwnProperty.call(schemas, route)) return null;
    const params = cleanParams(schemas[route], (s as { params?: unknown }).params);
    if (!params) return null;
    out.push({ route, params });
  }
  return out;
}

function cleanScroll(raw: unknown): SpotScroll | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.y !== 'number' || !Number.isFinite(r.y) || r.y < 0) return null;
  const out: { y: number; anchorId?: string; anchorDelta?: number } = { y: Math.round(r.y) };
  if (typeof r.anchorId === 'string' && r.anchorId.length > 0) {
    out.anchorId = r.anchorId;
    out.anchorDelta = typeof r.anchorDelta === 'number' && Number.isFinite(r.anchorDelta) ? r.anchorDelta : 0;
  }
  return out;
}

/** A spot from untrusted JSON (the restart marker), or null when it is not a
 *  valid spot of THIS version. */
export function parseResumeSpot(raw: unknown): ResumeSpot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== RESUME_SPOT_VERSION || !isTab(r.tab)) return null;
  if (r.page !== null && typeof r.page !== 'string') return null;
  const tabStack = cleanScreens(r.tabStack, TAB_ROUTES[r.tab]);
  const rootStack = cleanScreens(r.rootStack, ROOT_ROUTES);
  if (!tabStack || !rootStack) return null;
  return {
    v: RESUME_SPOT_VERSION,
    tab: r.tab,
    page: (r.page as PageId | null) ?? null,
    tabStack,
    rootStack,
    scroll: r.scroll == null ? null : cleanScroll(r.scroll),
  };
}

// ── Reading a navigation state ──

/** The slice of a react-navigation state this module reads. */
export interface NavStateLike {
  readonly index?: number;
  readonly routes: readonly NavRouteLike[];
}
export interface NavRouteLike {
  readonly name: string;
  readonly key?: string;
  readonly params?: unknown;
  readonly state?: NavStateLike;
}

export interface NavRouteRef {
  readonly name: string;
  readonly key: string;
  readonly params: unknown;
}

/** What the navigation state says about the logged-in app, before the allowlist. */
export interface NavShape {
  readonly tab: string;
  /** The tab stack's root route (TabPages lives here). */
  readonly tabRoot: NavRouteRef | null;
  readonly tabStack: readonly NavRouteRef[];
  readonly rootStack: readonly NavRouteRef[];
}

function focusedIndex(s: NavStateLike): number {
  return s.index ?? s.routes.length - 1;
}

function ref(r: NavRouteLike): NavRouteRef {
  return { name: r.name, key: r.key ?? '', params: r.params };
}

/** Finds `logged-in` on the focused path, then reads the tab container under it.
 *  Null when the reader is not inside the tab container (a gate, sign-in). */
export function readNavShape(root: NavStateLike | undefined | null): NavShape | null {
  let s: NavStateLike | undefined = root ?? undefined;
  let loggedIn: NavStateLike | undefined;
  for (let depth = 0; s && depth < 8; depth++) {
    const r: NavRouteLike | undefined = s.routes[focusedIndex(s)];
    if (!r) return null;
    if (r.name === 'logged-in') {
      loggedIn = r.state;
      break;
    }
    s = r.state;
  }
  if (!loggedIn) return null;
  const top = focusedIndex(loggedIn);
  const ac = loggedIn.routes.findIndex((r) => r.name === 'app_container');
  if (ac < 0 || ac > top) return null;
  const tabs = loggedIn.routes[ac].state;
  if (!tabs) return null;
  const tabRoute = tabs.routes[focusedIndex(tabs)];
  if (!tabRoute) return null;
  const stack = tabRoute.state;
  const stackRoutes = stack ? stack.routes.slice(0, focusedIndex(stack) + 1) : [];
  return {
    tab: tabRoute.name,
    tabRoot: stackRoutes[0] ? ref(stackRoutes[0]) : null,
    tabStack: stackRoutes.slice(1).map(ref),
    rootStack: loggedIn.routes.slice(ac + 1, top + 1).map(ref),
  };
}

/** The key of the screen on top (a root push, a tab push, or the tab root). */
export function topRouteKey(shape: NavShape): string | null {
  const top = shape.rootStack[shape.rootStack.length - 1] ?? shape.tabStack[shape.tabStack.length - 1] ?? shape.tabRoot;
  return top?.key || null;
}

/** The spot for a shape, or null when anything on it is not restorable. */
export function spotFromShape(
  shape: NavShape | null,
  page: PageId | null,
  scroll: SpotScroll | null,
): ResumeSpot | null {
  if (!shape || !isTab(shape.tab)) return null;
  const tab = shape.tab;
  const toScreens = (refs: readonly NavRouteRef[]) =>
    refs.map((r) => ({ route: r.name, params: r.params }));
  return parseResumeSpot({
    v: RESUME_SPOT_VERSION,
    tab,
    page,
    tabStack: toScreens(shape.tabStack),
    rootStack: toScreens(shape.rootStack),
    scroll,
  });
}

/** Route names along a shape or spot, for comparing a rebuild with its plan. */
export function routeChain(x: { tab: string; tabStack: readonly { name?: string; route?: string }[]; rootStack: readonly { name?: string; route?: string }[] }): string[] {
  return [
    `tab:${x.tab}`,
    ...x.tabStack.map((s) => `t:${s.route ?? s.name}`),
    ...x.rootStack.map((s) => `r:${s.route ?? s.name}`),
  ];
}

/** True when `actual` starts with `expected`. A screen opened on top during the
 *  rebuild (a notification tap) does not fail it. */
export function chainStartsWith(actual: readonly string[], expected: readonly string[]): boolean {
  return expected.every((v, i) => actual[i] === v);
}

// ── Rebuilding ──

export type RestoreStep =
  | { readonly kind: 'page'; readonly page: PageId }
  | { readonly kind: 'tab'; readonly href: string }
  | { readonly kind: 'push'; readonly href: string; readonly params: Readonly<Record<string, string>>; readonly chain: readonly string[] };

export function tabHref(tab: TabId): string {
  return `/logged-in/app_container/${tab}`;
}

/** The navigation calls that rebuild `spot`, in order. Each push carries the
 *  route chain expected once it lands. */
export function planRestore(spot: ResumeSpot): RestoreStep[] {
  const steps: RestoreStep[] = [];
  if (spot.page) steps.push({ kind: 'page', page: spot.page });
  steps.push({ kind: 'tab', href: tabHref(spot.tab) });
  const chain = [`tab:${spot.tab}`];
  for (const s of spot.tabStack) {
    chain.push(`t:${s.route}`);
    steps.push({ kind: 'push', href: `${tabHref(spot.tab)}/${s.route}`, params: s.params, chain: [...chain] });
  }
  for (const s of spot.rootStack) {
    chain.push(`r:${s.route}`);
    steps.push({ kind: 'push', href: `/logged-in/${s.route}`, params: s.params, chain: [...chain] });
  }
  return steps;
}

/** `spot` with its screens cut from index `at` of tabStack ++ rootStack, and
 *  no scroll (the top screen changed). */
export function truncateSpot(spot: ResumeSpot, at: number): ResumeSpot {
  const t = spot.tabStack.length;
  return {
    ...spot,
    tabStack: spot.tabStack.slice(0, Math.min(at, t)),
    rootStack: at <= t ? [] : spot.rootStack.slice(0, at - t),
    scroll: null,
  };
}

/** What a missing screen is called in the reader's toast; null: no special copy. */
export type MissingKind = 'story' | 'publication';

export function missingKindOf(route: string): MissingKind | null {
  if (route === 'publication') return 'publication';
  if (route === 'article-detail' || route === 'suggestion-detail' || route === 'story-timeline') return 'story';
  return null;
}

/** Pushed screens whose entity lives on a server, so only the screen can say it
 *  is gone (it reports through `reportRestoredScreen`). */
export const SCREEN_REPORTED_ROUTES: ReadonlySet<string> = new Set(['article-detail', 'publication']);

// ── Landing the scroll ──

/** Within this many pt of the goal counts as landed. */
export const SCROLL_LANDED_PT = 4;
/** The top list is hidden at most this long while its scroll lands (owner). */
export const SCROLL_LAND_MAX_MS = 1200;

export type LandOutcome = 'landed' | 'continue' | 'give-up';

/** One frame of the landing loop for an offset goal. A long list grows as it
 *  renders toward the offset, so the scroll is re-applied each frame until it
 *  holds or time runs out; then it stays wherever it got (near the goal). */
export function landStep(goal: number, offset: number, elapsedMs: number): LandOutcome {
  if (Math.abs(offset - goal) <= SCROLL_LANDED_PT) return 'landed';
  return elapsedMs >= SCROLL_LAND_MAX_MS ? 'give-up' : 'continue';
}
