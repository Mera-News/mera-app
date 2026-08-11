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
//
// SECOND GATE, added after Q1 flagged the gap: `proposeFactCheck` is declared
// CLOUD-ONLY (`ChatSessionView.tsx:145-151` — splicing its ~1,200-token claim
// rules into the local prompt blows the ~3,072-token on-device budget, 2,740
// → 4,145 measured). The "Quick fact check" starter chip is gated on
// `useIsOnDeviceProcessing()` for exactly that reason. Without the same gate
// here, tapping the tick on a device set to on-device processing seeds a turn
// into an agent with no tool to act on it — a silent mis-wire, not an error —
// so this checks the SAME store the chip does and no-ops identically to the
// free-tier chokepoint above. The caller still HIDES the tick in that state
// (see ArticleDetailScreen / ArticleSuggestionScreen) — this is the
// belt-and-suspenders backstop, not the primary defence, matching how
// `getAiAccess()` is enforced both at the store and at the call site.

import { hapticLight } from '../haptics';
import { ProcessingMode } from '../generated/graphql-types';
import { useFloatingChatStore } from '../stores/floating-chat-store';
import { useMeraProtocolStore } from '../stores/mera-protocol-store';

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
 * Fire-and-forget: a locked free-tier user, or a device set to on-device
 * processing (see the file header — `proposeFactCheck` is cloud-only), is
 * silently ignored.
 */
export function openFactCheckChat(article: FactCheckChatArticle, seedMessage: string): void {
    // Same signal `ChatSessionView`'s chip gate reads — read directly off the
    // store (not the `useIsOnDeviceProcessing()` hook) because this is a
    // plain function, not a component; `.getState()` is zustand's supported
    // outside-React read, the same pattern `getAiAccess()` uses.
    if (useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice) return;
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
