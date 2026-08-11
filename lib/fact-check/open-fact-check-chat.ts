// open-fact-check-chat — opening Mera AI from an article's fact-check tick.
//
// The tick has exactly one job, and it is not a rendering job: hand the
// floating chat an article context plus the opening user turn. That belongs
// in lib/ (testable, no RN), so the card/detail screen stays a screen.
//
// Retires `start-fact-check-chat.ts` and its standalone `kind: 'fact-check'`
// ChatContext (Q1 deletes both this wave): the quick claim-picker
// (`proposeFactCheck`) now lives on the ARTICLE agent itself, alongside
// "why this article" / "don't want this", because the chip sends into the
// SAME article thread rather than opening a separate one. One agent owning
// both means one context kind — `article-suggestion` — reaches both the
// quick pill list AND its always-last "The Article" async option.
//
// This reuses the EXISTING seeding seam rather than adding a second one, the
// same way `startFollowStoryChat` does:
// `openArticleFeedback(context, initialMessage)` sets the context, parks the
// auto-sent opening turn in `pendingInitialMessage`, and nulls
// `conversationId` so a fresh thread is created — all in one atomic set.
// ChatSessionView consumes the pending message exactly once after the thread
// mounts. Routing through it also keeps the free-tier chokepoint
// (`getAiAccess() === 'locked'` ⇒ silent no-op) in front of this entry point
// for free — which is why the tick must still be HIDDEN in that state by the
// caller (see ArticleDetailScreen / ArticleSuggestionScreen), not left to tap
// into nothing.

import { hapticLight } from '../haptics';
import { useFloatingChatStore } from '../stores/floating-chat-store';

/** The article a fact-check chat is opened from. Only what `article-suggestion`
 *  context needs to resolve the rest itself — see `ChatContext`'s own comment:
 *  "the agent resolves the other (and the suggestion row) from whichever id is
 *  provided." No description/url/publicationName any more (the old
 *  `kind: 'fact-check'` context carried those): the article agent already
 *  has full access to the article/suggestion row from the id alone. */
export interface FactCheckChatArticle {
    readonly articleId: string;
    readonly suggestionId?: string;
    readonly title: string;
}

/**
 * Opens Mera AI on the `article-suggestion` context for `article`, seeded
 * with `seedMessage` as the user's opening turn. Mera answers by proposing
 * 3–4 separately checkable claims as a single-select pill list, ALWAYS ending
 * with "The Article" — the async, server-checked option — as the last pill.
 *
 * The caller passes the RESOLVED string (the screen has `t`, this module
 * stays i18n-free) — see `FACT_CHECK_SEED_MESSAGE_KEY` in `fact-check-state.ts`
 * for which key to resolve it from.
 *
 * Fire-and-forget: a locked free-tier user is silently ignored by the store's
 * chokepoint.
 */
export function openFactCheckChat(article: FactCheckChatArticle, seedMessage: string): void {
    hapticLight();
    useFloatingChatStore.getState().openArticleFeedback(
        {
            kind: 'article-suggestion',
            articleId: article.articleId,
            ...(article.suggestionId ? { suggestionId: article.suggestionId } : {}),
            articleTitle: article.title,
        },
        seedMessage,
    );
}
