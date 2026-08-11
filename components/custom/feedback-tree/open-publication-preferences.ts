// The `manage_publication` nudge's one action: open the publication-preferences
// screen.
//
// It lives here, next to the tree, rather than being plumbed through each host's
// `onNudge` the way `browse_related` is — and the difference is real, not
// stylistic. `browse_related` means "open THIS suggestion's related coverage",
// so only the host knows which card and how to stamp its lifecycle.
// `manage_publication` takes no argument and has one destination on every
// surface; threading it through five component signatures would let three hosts
// disagree about where "manage publications" goes, which is precisely the
// D17 failure ("presentations may differ, semantics must not").
//
// Hosts still receive the nudge afterwards (they all ignore anything that isn't
// `browse_related`), so a host that later wants to do something extra — dismiss
// a sheet, log — can, without this navigation becoming optional.

import { router } from 'expo-router';
import logger from '@/lib/logger';

export const PUBLICATION_PREFERENCES_ROUTE = '/logged-in/publication-preferences' as const;

/** Navigate to the boost / downrank / mute screen. Never throws — a failed
 *  navigation must not take down the feedback surface that invoked it. */
export function openPublicationPreferences(): void {
  try {
    router.push(PUBLICATION_PREFERENCES_ROUTE);
  } catch (err) {
    logger.captureException(err, {
      tags: { component: 'feedback-tree', method: 'openPublicationPreferences' },
    });
  }
}
