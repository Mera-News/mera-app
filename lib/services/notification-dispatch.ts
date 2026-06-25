// notification-dispatch — decides whether to interrupt the user when an async
// scoring pass lands new results. Scores are already saved to the DB before
// this runs; this is purely a UX gate.
//
// Rules:
//   1. Hour ∈ preferredNotificationWindow → OS notification telling the user
//      how many articles are ready to process.
//   2. Otherwise → silent (DB is up to date; next foreground shows the update).
//
// The push count is suggestions that went through phase-2 reason generation
// (i.e. cleared the reconciler's relevance gate).

import * as Notifications from 'expo-notifications';
import logger from '@/lib/logger';
import { useUserStore } from '@/lib/stores/user-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';

export interface DispatchArgs {
  scoredIds: string[];
}

export async function dispatchResultsNotification(
  args: DispatchArgs,
): Promise<void> {
  const persona = useUserStore.getState().userPersona;
  if (!persona) return;

  const window = persona.preferredNotificationWindow ?? [];
  const visibleEnabled = persona.notificationsEnabled ?? false;

  const suggestionsById = new Map(
    useForYouStore.getState().suggestions.map((s) => [s._id, s]),
  );

  const readyCount = args.scoredIds.filter((id) => {
    const s = suggestionsById.get(id);
    return s?.status === ArticleSuggestionStatus.Complete;
  }).length;

  if (readyCount === 0) return;

  // Full opt-out suppresses all OS notifications. Scores stay saved; user
  // sees them on next foreground.
  if (!visibleEnabled) return;

  const hourUtc = new Date().getUTCHours();
  if (window.includes(hourUtc)) {
    const noun = `article${readyCount === 1 ? '' : 's'}`;
    await scheduleLocalNotif(
      `${readyCount} ${noun} to process`,
      'Open Mera to see what impacts you.',
    );
  }
}

async function scheduleLocalNotif(
  title: string,
  body: string,
): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: { type: 'inference-done-local' },
      },
      trigger: null,
    });
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'notification-dispatch' },
    });
  }
}
