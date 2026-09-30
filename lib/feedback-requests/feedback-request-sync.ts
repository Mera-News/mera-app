// feedback-request-sync: one pass of "what is the server asking right now",
// run by the `feedback-request-sync` scheduler task.
//
// For each live request the server returns:
//   - upsert the local entry, refreshing the question (the app language may
//     have changed since, and the server localizes);
//   - NEW to this device and not yet answered: one drawer row, WITHOUT a toast
//     (the pop-up is the loud path);
//   - the server says answered (another device, or a reinstall): stamp
//     answeredAt and mark the drawer row actioned.
// The state write lands BEFORE the drawer row, so a failure between the two
// can lose a row but never duplicate one.
//
// The auto-show host needs no separate signal: it listens to state writes and
// re-derives its candidate from the state (level-triggered), so a sync that
// runs before the host mounts is still picked up when it does.

import { notify, markActionedBySource } from '@/lib/database/services/notification-service';
import { updateFeedbackRequestsState } from './feedback-request-state';
import {
  fetchActiveFeedbackRequests,
  type ActiveFeedbackRequest,
} from './feedback-request-service';

export const FEEDBACK_REQUEST_NOTIFICATION_TYPE = 'feedback_request';
/** i18n key; the body is the question itself, stored raw. */
export const FEEDBACK_REQUEST_NOTIFICATION_TITLE_KEY = 'feedbackRequest.title';

export function feedbackRequestNotificationSource(id: string): string {
  return `feedback_request:${id}`;
}

export interface FeedbackRequestSyncResult {
  ok: boolean;
  fetched: number;
  newRows: number;
  answered: number;
}

/**
 * Fold a server list into local state plus drawer rows. Shared by the sync
 * task and by the modal's own fetch (a push tap that beats the first sync),
 * so either path leaves the same local record. "New" is decided inside the
 * serialized write, never from an earlier read.
 */
export async function ingestFeedbackRequests(
  requests: readonly ActiveFeedbackRequest[],
  now: number = Date.now(),
): Promise<{ newRows: number; answered: number }> {
  if (requests.length === 0) return { newRows: 0, answered: 0 };
  const fresh: ActiveFeedbackRequest[] = [];
  const answeredNow: string[] = [];

  await updateFeedbackRequestsState((s) => {
    fresh.length = 0;
    answeredNow.length = 0;
    for (const r of requests) {
      const existing = s[r.id];
      const entry = existing ?? { question: r.question, endsAt: r.endsAt };
      entry.question = r.question;
      entry.endsAt = r.endsAt;
      if (r.answered && entry.answeredAt === undefined) {
        entry.answeredAt = now;
        // A row exists only for an entry the device already knew.
        if (existing) answeredNow.push(r.id);
      }
      s[r.id] = entry;
      // Already answered on first sight (another device, a reinstall): no
      // drawer row, there is nothing left to ask.
      if (!existing && !r.answered) fresh.push(r);
    }
  }, now);

  let newRows = 0;
  for (const r of fresh) {
    await notify({
      type: FEEDBACK_REQUEST_NOTIFICATION_TYPE,
      title: FEEDBACK_REQUEST_NOTIFICATION_TITLE_KEY,
      body: r.question,
      icon: null,
      context: { feedbackRequestId: r.id, endsAt: r.endsAt },
      source: feedbackRequestNotificationSource(r.id),
    });
    newRows += 1;
  }
  for (const id of answeredNow) {
    await markActionedBySource(feedbackRequestNotificationSource(id));
  }
  return { newRows, answered: answeredNow.length };
}

export async function syncFeedbackRequests(
  appLanguage: string,
  now: number = Date.now(),
): Promise<FeedbackRequestSyncResult> {
  const result = await fetchActiveFeedbackRequests(appLanguage);
  if (!result.ok) return { ok: false, fetched: 0, newRows: 0, answered: 0 };
  const { newRows, answered } = await ingestFeedbackRequests(result.requests, now);
  return { ok: true, fetched: result.requests.length, newRows, answered };
}
