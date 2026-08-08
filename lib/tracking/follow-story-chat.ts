// follow-story-chat — opening the "follow a story" Mera chat from the
// Followed-stories screen's track FAB.
//
// The FAB has exactly one job, and it is not a rendering job: hand the floating
// chat a follow-story context plus the opening user turn. That belongs in lib/
// (testable, no RN), so the screen stays a screen.
//
// This reuses the EXISTING seeding seam rather than adding a second one:
// `openArticleFeedback(context, initialMessage)` is the store action that sets
// the context, parks the auto-sent opening turn in `pendingInitialMessage`, and
// nulls `conversationId` so a fresh thread is created — all in one atomic set.
// ChatSessionView consumes the pending message exactly once after the thread
// mounts (the same path the article "Ask Mera"/Track taps take, see
// lib/tracking/use-tracked-subject.ts). Its name is article-shaped for
// historical reasons; its behaviour is context-agnostic, and routing through it
// also keeps the free-tier chokepoint (`getAiAccess() === 'locked'` ⇒ silent
// no-op) in front of this entry point for free.

import { hapticLight } from '../haptics';
import { useFloatingChatStore } from '../stores/floating-chat-store';

/**
 * Open Mera on the follow-a-story context, seeded with `seedMessage` as the
 * user's opening turn ("I want to follow a story"). Mera answers by asking what
 * they want to follow; from there the normal proposeTrack → scope-pill card →
 * tap-to-confirm flow takes over and mints the followed story.
 *
 * The caller passes the RESOLVED string (the screen has `t`), so this stays
 * i18n-free. Fire-and-forget: a locked free-tier user is silently ignored by the
 * store's chokepoint, which is why the FAB is hidden in that state rather than
 * left to click into nothing.
 */
export function startFollowStoryChat(seedMessage: string): void {
  hapticLight();
  useFloatingChatStore.getState().openArticleFeedback({ kind: 'follow-story' }, seedMessage);
}
