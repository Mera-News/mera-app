// request-article-fact-check — what the article's fact-check tick does.
//
// Renamed from `open-fact-check-chat.ts`, because the tick no longer opens a
// chat. It USED to seed Mera AI with an opening user turn ("what can be fact
// checked here?") and let the article agent's claim picker take over. On a
// real device that produced this, verbatim:
//
//   "I can't offer much here — the article metadata gives me only a headline
//    ... There's nothing specific to fact-check from this alone."
//
// The tick now asks the SERVER for a check on this article, directly. No chat
// opens, the panel goes to `processing` in place, and the answer lands in the
// same panel. `requestFactCheck` (fact-check-graphql-client) already does the
// ask-and-mirror in one call and is documented never to throw, so this module
// is the gate layer plus the tap feedback, nothing more.
//
// THE AI-ASSISTED PATH IS NOT LOST AND MUST NOT BE REBUILT HERE. Mera AI's
// "Quick fact check" starter chip still offers the claim picker
// (`proposeFactCheck`, on the `article-suggestion` context) for a reader who
// wants to check ONE claim rather than the article. That chip is untouched.
// This tick is the other half: "check this story", answered by the server.
//
// ── THE GATES, AND WHY ONE OF THEM WENT AWAY ─────────────────────────────────
//
// ENTITLEMENT — STAYS. `factCheck` and `requestFactCheck` are both behind
// `SubscriptionGuard` on the server, so a locked free-tier tap could only ever
// produce an error. Checked here AND at the call sites, which HIDE the tick in
// that state: a tick that visibly does nothing is worse than no tick. This used
// to be enforced for free by routing through the chat store's own chokepoint;
// with the chat gone from this path, the check has to be explicit.
//
// ON-DEVICE PROCESSING — REMOVED, DELIBERATELY. That gate existed for exactly
// one reason: `proposeFactCheck` is CLOUD-ONLY (splicing its ~1,200-token claim
// rules into the local prompt blew the ~3,072-token on-device budget), so
// seeding a turn into a local agent with no such tool was a silent mis-wire. A
// SERVER fact check needs no cloud chat at all, so a reader on on-device
// processing can now legitimately ask for one — and the tick is no longer
// hidden for them. If you are re-adding a `processingMode` check here, check
// first that you are not confusing the chat's claim picker with the server's
// article check; they are different features now.
//
// FACT CHECK ENABLED — NEW. `factCheckEnabled` (Mera Protocol settings,
// persisted as `mera_fact_check`, default on) used to be decorative: it
// persisted and nothing read it. The tick, the panel and the article mirror all
// honour it now. Checked here as well as at the call sites, matching how
// entitlement is enforced in both places.

import { hapticLight } from '../haptics';
import { getAiAccess } from '../stores/subscription-store';
import { useMeraProtocolStore } from '../stores/mera-protocol-store';
import { requestFactCheck } from './fact-check-graphql-client';
import type { FactCheckKeepInput } from '../database/services/saved-article-suggestion-service';
import type { ForYouSuggestion } from '../stores/for-you-store';
import type { NewsArticle } from '../generated/graphql-types';

/** The article the tick was tapped on. `title` is a fallback label for the
 *  local row while the server's own snapshot is still unknown — the server
 *  sends back its own `articleTitle` and that wins. `suggestionId` is no longer
 *  read (it existed to address the chat's suggestion row) and is kept off the
 *  interface rather than accepted and ignored.
 *
 *  `article` / `suggestion` are OPTIONAL full shapes used only for retention
 *  snapshotting (a fact-checked article is kept openable like a saved one);
 *  the request itself still needs only `articleId` + `title`, and a caller
 *  without a full shape in hand gets a degraded snapshot built from the
 *  server's own row. */
export interface FactCheckArticle {
    readonly articleId: string;
    readonly title: string;
    readonly article?: NewsArticle;
    readonly suggestion?: ForYouSuggestion;
}

/**
 * Ask the server for this article's fact check.
 *
 * Fire-and-forget and never throws: a locked free-tier reader, or one who has
 * turned fact checking off, is silently ignored (both states also hide the
 * tick), and `requestFactCheck` swallows its own transport failures — a failed
 * ask degrades to "no answer yet", which is what the panel would show anyway.
 *
 * Returns whether the request was actually issued, so a caller (and the tests)
 * can tell a gated no-op from a real ask.
 */
export function requestArticleFactCheck(article: FactCheckArticle): boolean {
    if (!article?.articleId) return false;
    // Read straight off the stores rather than through the hooks: this is a
    // plain function, not a component. `.getState()` is zustand's supported
    // outside-React read, and `getAiAccess()` is the imperative twin the store
    // exposes for exactly these callers.
    if (getAiAccess() === 'locked') return false;

    hapticLight();
    // Retention input built HERE, behind the gates above: a gated no-op must
    // not create a retention row.
    const keep: FactCheckKeepInput | undefined = article.article
        ? { articleId: article.articleId, article: article.article }
        : article.suggestion
            ? { articleId: article.articleId, suggestion: article.suggestion }
            : undefined;
    // Not awaited: the tap's job is to lodge the ask. Everything after it is
    // the panel's, driven by the local row this writes and by `useFactCheck`'s
    // live subscription to it.
    void requestFactCheck(article.articleId, article.title, keep);
    return true;
}
