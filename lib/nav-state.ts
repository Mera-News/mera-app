// Tracks the current expo-router pathname in a module variable so non-React
// code (the Apollo error link, the route gate) can make routing decisions
// without a hook. Updated from the root layout via usePathname().

import { router } from 'expo-router';
import { notifyTimeTick } from './time-tick';

const PAYWALL_PATH = '/logged-in/not-subscribed';

let currentPathname = '';
// Synchronous guard: set the instant we issue a paywall navigation so two
// near-simultaneous 402s (e.g. the route gate + the error link for the same
// query) don't both navigate and stack two paywall screens. Cleared once the
// route actually settles somewhere other than the paywall.
let navigatingToPaywall = false;

export function setCurrentPathname(pathname: string): void {
  const changed = pathname !== currentPathname;
  currentPathname = pathname;
  if (!pathname.includes('not-subscribed')) {
    navigatingToPaywall = false;
  }
  // Route change ⇒ a screen just came into view: refresh every relative
  // timestamp NOW rather than leaving it up to the 60s tick. This is the
  // app-wide "on focus" signal the ticker needs — the root layout already calls
  // this on every pathname change, so one call here covers every screen, and no
  // screen needs its own focus effect.
  //
  // Ages ONLY. `notifyTimeTick` publishes to `lib/time-tick` subscribers, and
  // the only subscriber is the leaf that renders an age (ArticleMetaRow) — it
  // sits below every card's React.memo boundary, so this cannot re-render a list
  // screen and cannot touch the Dashboard's 30-minute sort snapshot.
  if (changed) notifyTimeTick();
}

export function getCurrentPathname(): string {
  return currentPathname;
}

/**
 * Idempotently route to the paywall. No-op if we're already there or a paywall
 * navigation is already in flight — callers can fire this on every 402 safely.
 */
export function navigateToPaywall(): void {
  if (navigatingToPaywall || currentPathname.includes('not-subscribed')) return;
  navigatingToPaywall = true;
  router.replace(PAYWALL_PATH as never);
}
