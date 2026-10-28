// Where the reader is, captured before an update reload and rebuilt after it,
// so an update never moves them (owner rule). The pure half (shape, allowlist,
// parsing, the plan) is `resume-spot-core.ts`; this file holds the runtime:
// the registries screens write to, `captureSpot` and `restoreSpot`.
//
// Nothing here is persisted and nothing records what the reader looks at over
// time: it is the current place only, read once at departure (invariant 9).
// When and where a spot is kept is the restart marker's business
// (lib/app-restart.ts), not this module's.
//
// Every app module is required at CALL time, never at module scope: the gate,
// the restart marker and their tests load this file, and expo-router, the nav
// stores and the database would drag a native graph into all of them.

import type { PageId, TabId } from '@/lib/navigation/page-order';

import {
  SCREEN_REPORTED_ROUTES,
  chainStartsWith,
  missingKindOf,
  planRestore,
  readNavShape,
  routeChain,
  spotFromShape,
  topRouteKey,
  truncateSpot,
  type MissingKind,
  type NavStateLike,
  type ResumeSpot,
  type SpotScreen,
} from './resume-spot-core';

export type { MissingKind, ResumeSpot, SpotScreen } from './resume-spot-core';
export { parseResumeSpot, RESUME_SPOT_VERSION } from './resume-spot-core';

export type RestoreResult = 'restored' | 'fallback' | 'failed';

/** restoreSpot bounds itself to this; the gate's own cap sits above it. */
export const RESTORE_BUDGET_MS = 2500;
/** How long the rebuild waits for an article or publication screen to say
 *  whether its entity still exists, inside the budget. */
export const SCREEN_REPORT_WAIT_MS = 1500;
/** Frames a single navigation call may take to show in the state. */
const SETTLE_FRAMES = 30;

// ── Registries screens write to ──

const activePages = new Map<TabId, PageId>();
const screenReports = new Map<string, 'ready' | 'missing'>();
/** Restored screens that may still report missing after the rebuild resolved. */
const lateWatch = new Set<string>();

/** TabPages: the page its tab shows now. A plain write, no render. */
export function noteActivePage(tab: TabId, page: PageId): void {
  activePages.set(tab, page);
}

/** An article or publication screen: whether its entity exists. Only a restored
 *  screen acts on it: one found missing after the rebuild pops itself. */
export function reportRestoredScreen(routeKey: string, status: 'ready' | 'missing'): void {
  if (!routeKey) return;
  screenReports.set(routeKey, status);
  if (!lateWatch.has(routeKey)) return;
  lateWatch.delete(routeKey);
  if (status !== 'missing') return;
  try {
    const shape = readNavShape(deps().navRef()?.getRootState() as NavStateLike | undefined);
    if (shape && topRouteKey(shape) === routeKey) deps().router().back();
  } catch {
    // The reader is looking at the screen's own not-found state; nothing to undo.
  }
}

// ── Restore-in-progress, for the few readers outside ──

type Listener = () => void;
const listeners = new Set<Listener>();
let restoring = false;
let lastMissing: MissingKind | null = null;

function emit(): void {
  for (const l of [...listeners]) l();
}

export function subscribeResumeSpot(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** True while restoreSpot runs (stack layouts push with no animation). */
export function isRestoreInProgress(): boolean {
  return restoring;
}

/** What the last rebuild found gone, for the reader's toast; null when nothing
 *  that has its own copy was missing. */
export function lastRestoreMissing(): MissingKind | null {
  return lastMissing;
}

// ── Dependencies (real by default, faked in tests) ──

interface RouterLike {
  push(href: { pathname: string; params: Record<string, string> }): void;
  replace(href: string): void;
  back(): void;
}
interface NavRefLike {
  isReady(): boolean;
  getRootState(): unknown;
}
export interface ResumeSpotDeps {
  router(): RouterLike;
  navRef(): NavRefLike | null;
  setPendingPage(page: PageId): void;
  arrangeOpen(): boolean;
  /** Whether a local entity a screen needs still exists; undefined: not probed. */
  probe(screen: SpotScreen): Promise<boolean> | undefined;
  nextFrame(): Promise<void>;
  now(): number;
}

const realDeps: ResumeSpotDeps = {
  router: () => (require('expo-router') as typeof import('expo-router')).router as unknown as RouterLike,
  navRef: () => {
    // expo-router's hook is a plain getter for its global container ref
    // (build/hooks.js returns store.navigationRef), so this call is safe
    // outside React. No mount site has to register it before the gate runs.
    const { useNavigationContainerRef: getRef } = require('expo-router') as typeof import('expo-router');
    return getRef() as unknown as NavRefLike;
  },
  setPendingPage: (page) =>
    (require('@/components/custom/nav/navigate-to-page') as typeof import('@/components/custom/nav/navigate-to-page')).setPendingPage(page),
  arrangeOpen: () =>
    (require('@/components/custom/nav/current-surface') as typeof import('@/components/custom/nav/current-surface')).useCurrentSurfaceStore.getState().arrangeOpen,
  probe: (screen) => probeLocal(screen),
  nextFrame: () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
  now: () => Date.now(),
};

let testDeps: Partial<ResumeSpotDeps> | null = null;
function deps(): ResumeSpotDeps {
  return testDeps ? { ...realDeps, ...testDeps } : realDeps;
}

/** The entities that live on this phone: a gone one is cut before navigating. */
function probeLocal(screen: SpotScreen): Promise<boolean> | undefined {
  switch (screen.route) {
    case 'story-timeline': {
      const svc = require('@/lib/database/services/tracked-story-service') as typeof import('@/lib/database/services/tracked-story-service');
      return svc.getTrackedStoryById(screen.params.trackedStoryId).then((r) => r !== null);
    }
    case 'interest':
    case 'fact': {
      const svc = require('@/lib/database/services/fact-service') as typeof import('@/lib/database/services/fact-service');
      const { firstValueFrom } = require('rxjs') as typeof import('rxjs');
      return firstValueFrom(svc.observeFact(screen.params.factId)).then((f) => f !== null);
    }
    case 'suggestion-detail': {
      const database = (require('@/lib/database') as typeof import('@/lib/database')).default;
      return database
        .get('article_suggestions')
        .find(screen.params.articleSuggestionId)
        .then(() => true, () => false);
    }
    default:
      return undefined;
  }
}

// ── Capture ──

/**
 * Where the reader is now, or null when that place cannot be rebuilt exactly
 * (a screen off the allowlist, World's Arrange open, outside the tab container,
 * navigation not ready). Synchronous and cheap: it runs at departure.
 */
export function captureSpot(): ResumeSpot | null {
  try {
    const d = deps();
    const nav = d.navRef();
    if (!nav?.isReady() || d.arrangeOpen()) return null;
    const shape = readNavShape(nav.getRootState() as NavStateLike);
    if (!shape) return null;
    return spotFromShape(shape, activePages.get(shape.tab as TabId) ?? null);
  } catch {
    return null;
  }
}

// ── Restore ──

class Aborted extends Error {}

/**
 * Rebuild `spot` from a freshly booted navigator (the gate calls it instead of
 * opening the startup tab). 'restored': all of it. 'fallback': a story,
 * publication or fact was gone, and the reader lands on the screen under it,
 * same tab and page. 'failed': anything else (bad spot, a navigation call that
 * threw or did not land, the budget ran out, or `signal` aborted); the caller
 * opens the startup tab. After an abort nothing more is pushed.
 *
 * Resolves once the screens are in place. Every list opens at its top.
 */
export async function restoreSpot(spot: ResumeSpot, opts: { signal?: AbortSignal } = {}): Promise<RestoreResult> {
  const d = deps();
  const deadline = d.now() + RESTORE_BUDGET_MS;
  const check = () => {
    if (opts.signal?.aborted || d.now() > deadline) throw new Aborted();
  };
  lastMissing = null;
  restoring = true;
  emit();
  try {
    if (!spot || spot.v !== 1) return 'failed';
    let target = spot;
    let result: RestoreResult = 'restored';

    // Cut at the first local entity that is gone.
    const screens = [...spot.tabStack, ...spot.rootStack];
    for (let i = 0; i < screens.length; i++) {
      const exists = await d.probe(screens[i]);
      check();
      if (exists === false) {
        target = truncateSpot(spot, i);
        result = 'fallback';
        lastMissing = missingKindOf(screens[i].route);
        break;
      }
    }

    const router = d.router();
    for (const step of planRestore(target)) {
      check();
      if (step.kind === 'page') {
        d.setPendingPage(step.page);
      } else if (step.kind === 'tab') {
        router.replace(step.href);
        await settle(d, [`tab:${target.tab}`], check);
      } else {
        router.push({ pathname: step.href, params: { ...step.params } });
        await settle(d, step.chain, check);
      }
    }

    const shape = readNavShape(d.navRef()?.getRootState() as NavStateLike);
    if (!shape || !chainStartsWith(routeChain(shape), routeChain(target))) return 'failed';
    const topKey = topRouteKey(shape);

    // An article or publication can only say it is gone once it loads.
    const top = target.rootStack[target.rootStack.length - 1];
    if (top && topKey && SCREEN_REPORTED_ROUTES.has(top.route)) {
      const waitUntil = Math.min(deadline, d.now() + SCREEN_REPORT_WAIT_MS);
      while (!screenReports.has(topKey) && d.now() < waitUntil && !opts.signal?.aborted) await d.nextFrame();
      check();
      if (screenReports.get(topKey) === 'missing') {
        router.back();
        lastMissing = missingKindOf(top.route);
        return 'fallback';
      }
      if (!screenReports.has(topKey)) lateWatch.add(topKey);
    }

    return result;
  } catch {
    return 'failed';
  } finally {
    restoring = false;
    emit();
  }
}

async function settle(d: ResumeSpotDeps, chain: readonly string[], check: () => void): Promise<void> {
  for (let i = 0; i < SETTLE_FRAMES; i++) {
    const nav = d.navRef();
    const shape = nav?.isReady() ? readNavShape(nav.getRootState() as NavStateLike) : null;
    if (shape && chainStartsWith(routeChain(shape), chain)) return;
    await d.nextFrame();
    check();
  }
  throw new Error('navigation did not settle');
}

// ── Tests ──

export function __setResumeSpotDepsForTests(next: Partial<ResumeSpotDeps> | null): void {
  testDeps = next;
}

export function __resetResumeSpotForTests(): void {
  testDeps = null;
  activePages.clear();
  screenReports.clear();
  lateWatch.clear();
  restoring = false;
  lastMissing = null;
  listeners.clear();
}
