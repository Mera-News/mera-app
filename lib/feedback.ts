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
import { SENTRY_ENABLED } from './sentry-init';

export function showFeedback(): void {
  if (!SENTRY_ENABLED) {
    console.warn(
      '[feedback] Sentry is disabled; set EXPO_PUBLIC_SENTRY_IN_DEV=true to test the feedback widget in a dev build.',
    );
    return;
  }
  useFeedbackStore.getState().show();
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
