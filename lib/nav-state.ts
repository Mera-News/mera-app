// Tracks the current expo-router pathname in a module variable so non-React
// code (the Apollo error link, the route gate) can make routing decisions
// without a hook. Updated from the root layout via usePathname().

import { router } from 'expo-router';

const PAYWALL_PATH = '/logged-in/not-subscribed';

let currentPathname = '';
// Synchronous guard: set the instant we issue a paywall navigation so two
// near-simultaneous 402s (e.g. the route gate + the error link for the same
// query) don't both navigate and stack two paywall screens. Cleared once the
// route actually settles somewhere other than the paywall.
let navigatingToPaywall = false;

export function setCurrentPathname(pathname: string): void {
  currentPathname = pathname;
  if (!pathname.includes('not-subscribed')) {
    navigatingToPaywall = false;
  }
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
