// Single entry point for opening Sentry's built-in User Feedback widget.
//
// Sentry.init only runs when SENTRY_ENABLED is true (production, or a dev build
// with EXPO_PUBLIC_SENTRY_IN_DEV=true — see lib/sentry-init.ts). Without init the
// feedbackIntegration isn't registered and showFeedbackWidget would no-op, so we
// gate on the same flag and route both triggers (Preferences row + FAB) here.

import * as Sentry from '@sentry/react-native';
import { SENTRY_ENABLED } from './sentry-init';

export function showFeedback(): void {
  if (!SENTRY_ENABLED) {
    console.warn(
      '[feedback] Sentry is disabled; set EXPO_PUBLIC_SENTRY_IN_DEV=true to test the feedback widget in a dev build.',
    );
    return;
  }
  Sentry.showFeedbackWidget();
}
