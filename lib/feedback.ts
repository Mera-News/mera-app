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
