// start-fact-check-chat — opening the "fact-check this" Mera chat from an
// article's fact-check tick.
//
// The tick has exactly one job, and it is not a rendering job: hand the floating
// chat a fact-check context plus the opening user turn. That belongs in lib/
// (testable, no RN), so the card/detail screen stays a screen.
//
// This reuses the EXISTING seeding seam rather than adding a second one:
// `openArticleFeedback(context, initialMessage)` sets the context, parks the
// auto-sent opening turn in `pendingInitialMessage`, and nulls `conversationId`
// so a fresh thread is created — all in one atomic set. Its name is
// article-shaped for historical reasons; its behaviour is context-agnostic, and
// routing through it keeps the PAID-TIER chokepoint (`getAiAccess() ===
// 'locked'` ⇒ silent no-op) in front of this entry point for free. That
// chokepoint IS the spend gate for the whole feature — there is no second one.

import { hapticLight } from '../haptics';
import { useFloatingChatStore } from '../stores/floating-chat-store';

/** The article a fact-check chat is started from. Headline + summary only:
 *  reading the article body is explicitly out of scope, and `url` is carried for
 *  the eventual citation rather than to be fetched. */
export interface FactCheckChatArticle {
  articleId: string;
  title: string;
  description?: string | null;
  url?: string | null;
  publicationName?: string | null;
}

/** English fallback for the seeded opening turn.
 *
 *  ⚠️ This string is RENDERED IN THE THREAD as the user's own first message, so
 *  the fallback is user-visible copy, not an internal default. The call site
 *  should pass `t('factCheck.chatSeed')`; this exists so a call site can land
 *  before its locale key does, and so this module stays i18n-free the way
 *  `startFollowStoryChat` does. If a non-English reader sees English here, the
 *  caller is relying on the fallback. */
const DEFAULT_SEED_MESSAGE = 'What can be fact-checked in this story?';

/**
 * Open Mera on the fact-check context for `article`, seeded with `seedMessage`
 * as the user's opening turn. Mera answers by proposing 3–4 separately checkable
 * claims as a single-select card; tapping one enqueues the background check.
 *
 * Fire-and-forget: a locked free-tier user is silently ignored by the store's
 * chokepoint, which is why the tick should be HIDDEN in that state rather than
 * left to tap into nothing.
 */
export function startFactCheckChat(
  article: FactCheckChatArticle,
  seedMessage: string = DEFAULT_SEED_MESSAGE,
): void {
  hapticLight();
  useFloatingChatStore.getState().openArticleFeedback(
    {
      kind: 'fact-check',
      articleId: article.articleId,
      title: article.title,
      // Optional keys are OMITTED rather than set to undefined so the context
      // object compares cleanly and nothing downstream has to distinguish
      // "absent" from "explicitly nothing".
      ...(article.description ? { description: article.description } : {}),
      ...(article.url ? { url: article.url } : {}),
      ...(article.publicationName ? { publicationName: article.publicationName } : {}),
    },
    seedMessage,
  );
}
