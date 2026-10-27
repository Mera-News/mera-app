// Single entry point for opening the "Report a Bug" feedback form.
//
// The form is Sentry's `FeedbackWidget` component, rendered by us in
// FeedbackWidgetModal so its labels can be localized (see that component). We
// don't call Sentry.showFeedbackWidget() — that native path freezes English
// labels at Sentry.init(), before the user's language is applied.
//
// Sentry.init only runs when SENTRY_ENABLED is true (production, or a dev build
// with EXPO_PUBLIC_SENTRY_IN_DEV=true — see lib/sentry-init.ts). Without init,
// captureFeedback (called by FeedbackWidget on submit) no-ops, so we gate on the
// same flag and route both triggers (Preferences row + FAB) here.

import * as Sentry from '@sentry/react-native';

import { useFeedbackStore } from './stores/feedback-store';
import { SENTRY_ENABLED, setPrefilledReportPending } from './sentry-init';

// Sentry RN 7.11 keeps the unsent draft in a TS-private static. A spec pins that
// it exists, so an SDK change fails loudly instead of silently dropping the prefill.
export type FeedbackWidgetInternals = {
  _savedState: { description: string };
  reset: () => void;
};
export const feedbackWidgetInternals = () => Sentry.FeedbackWidget as unknown as FeedbackWidgetInternals;

// True from showFeedback({ prefill }) until that report is sent or abandoned.
let prefilledReportOpen = false;

/** The prefilled sheet has fully closed. An unsent draft is wiped (after the
 *  widget unmounted: its unmount saves the draft back); a sent one leaves the
 *  Sentry-side flag for the event processor to consume. */
export function finishPrefilledReport(sent: boolean): void {
  if (!prefilledReportOpen) return;
  prefilledReportOpen = false;
  if (!sent) {
    feedbackWidgetInternals().reset();
    setPrefilledReportPending(false);
  }
}

export function showFeedback(opts?: { prefill?: string }): void {
  if (!SENTRY_ENABLED) {
    console.warn(
      '[feedback] Sentry is disabled; set EXPO_PUBLIC_SENTRY_IN_DEV=true to test the feedback widget in a dev build.',
    );
    return;
  }
  const prefill = opts?.prefill;
  if (prefill) {
    feedbackWidgetInternals()._savedState.description = prefill;
    prefilledReportOpen = true;
    setPrefilledReportPending(true);
  } else {
    prefilledReportOpen = false;
    setPrefilledReportPending(false);
  }
  useFeedbackStore.getState().show({ prefilled: !!prefill });
}

const FEATURE_REQUEST_PREFIX = '[Feature Request] ';

// Submits an agent-proposed feature request as Sentry user feedback (same sink
// as the "Report a Bug" widget above, so both land in the same Sentry Feedback
// stream). Unlike the widget path, this is invoked deterministically by the
// proposal executor (lib/chat-tools/proposal-handlers.ts) — no UI, no
// name/email (no PII; the widget's email field is opt-in and human-driven,
// this path isn't). Gated on the same SENTRY_ENABLED flag as showFeedback.
export function submitFeatureRequest(title: string, summary: string): boolean {
  if (!SENTRY_ENABLED) {
    console.warn(
      '[feedback] Sentry is disabled; set EXPO_PUBLIC_SENTRY_IN_DEV=true to test feature-request submission in a dev build.',
    );
    return false;
  }
  // Defensive: the prefix is applied here, once. Strip it if a caller already
  // included it so it's never doubled.
  const cleanTitle = title.startsWith(FEATURE_REQUEST_PREFIX)
    ? title.slice(FEATURE_REQUEST_PREFIX.length)
    : title;
  Sentry.captureFeedback({
    message: `${FEATURE_REQUEST_PREFIX}${cleanTitle}\n\n${summary}`,
    tags: { 'feedback.source': 'mera-agent' },
  });
  return true;
}
