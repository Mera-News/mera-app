// Tracks the current expo-router pathname in a module variable so non-React
// code (the Apollo error link, the route gate) can make routing decisions
// without a hook. Updated from the root layout via usePathname().

import { notifyTimeTick } from './time-tick';
import { bumpTranslationEpoch } from './translation-queue';

let currentPathname = '';

export function setCurrentPathname(pathname: string): void {
  const changed = pathname !== currentPathname;
  currentPathname = pathname;
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

  // Same signal, second consumer: a route change retires every translation
  // request queued for the screen the user just left. Native translation cannot
  // be cancelled once dispatched, but a call that was never made costs nothing
  // — and the queue is strictly serial, so those stale titles are exactly what
  // the NEW screen's title would otherwise wait behind. Cheap: a counter bump
  // and one pass over a queue that is usually tens of items long, and a no-op
  // when nothing is queued.
  if (changed) bumpTranslationEpoch(pathname);
}

export function getCurrentPathname(): string {
  return currentPathname;
}

// navigateToPaywall lived here until 2026-08-19: the standalone paywall
// screen was removed (Mera News Free + FreeTierCard is the whole unentitled
// experience), so nothing navigates on a 402 anymore — the feed's own card
// appears the moment aiAccess reads 'locked'.
