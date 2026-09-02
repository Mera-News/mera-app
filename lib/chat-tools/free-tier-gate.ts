// The ONE place this area decides "is this user on the free tier right now".
//
// Every free-tier branch in the chat area reads `isChatLocked()`. Nothing else
// in lib/chat-tools, lib/inference, lib/fact-check or components/custom/
// floating-chat may read entitlement state directly — a second reader is how
// the rule drifts, and this one has a specific trap in it (see below).
//
// WHY THIS LIVES IN lib/chat-tools AND NOT IN components/custom/floating-chat:
// four consumers are UI, but two are not — the topic-generation guards in
// ./tool-handlers.ts and in lib/inference/handlers/topic-gen-handler.ts. `lib/`
// must not import from `components/`, so moving this file next to its UI
// callers would invert the dependency and break those two. Do not "tidy" it
// there.

import {
    getAiAccess,
    useSubscriptionStore,
} from '@/lib/stores/subscription-store';
import { aiAccessIsServerResolved } from '@/lib/subscription/ai-access';
import type { ChatContext } from '@/lib/stores/floating-chat-store';

/**
 * Is the AI layer closed for this user RIGHT NOW, with the server having
 * actually said so?
 *
 * ## Never use `getAiAccess() === 'locked'` on its own for this
 *
 * It returns `'locked'` from an identified-but-empty RevenueCat CustomerInfo
 * while `serverTier` is still `null` — i.e. on every cold start, before the
 * `userBilling` round trip lands. A bare `=== 'locked'` check therefore tells a
 * PAYING subscriber that chat needs a plan, for the first second of every
 * launch. `aiAccessIsServerResolved` is the existing helper that distinguishes
 * "the server answered" from "we have not heard yet", and it already mirrors
 * the dev-override and ship-gate short-circuits, so the two compose exactly.
 *
 * ## Fails OPEN
 *
 * Unknown, unresolved, or a throw from the store all return `false` (not
 * locked). Wrongly refusing a subscriber is worse than briefly allowing one
 * extra action, and the surfaces below are all recoverable.
 */
export function isChatLocked(): boolean {
    try {
        const { serverTier } = useSubscriptionStore.getState();
        if (!aiAccessIsServerResolved(serverTier)) return false;
        return getAiAccess() === 'locked';
    } catch {
        // A store read should not throw, but a gate that crashes the chat is a
        // worse failure than a gate that lets one action through.
        return false;
    }
}

/** i18n keys for the free-tier opener, one per chat surface. */
export const FREE_TIER_OPENER_KEYS = {
    followStory: 'freeTier.chatIntro.followStory',
    articleFeedback: 'freeTier.chatIntro.articleFeedback',
    persona: 'freeTier.chatIntro.persona',
    optimisationPlan: 'freeTier.chatIntro.optimisationPlan',
    tutorialHelp: 'freeTier.chatIntro.tutorialHelp',
    factCheck: 'freeTier.chatIntro.factCheck',
    default: 'freeTier.chatIntro.default',
} as const;

export type FreeTierOpenerKey =
    (typeof FREE_TIER_OPENER_KEYS)[keyof typeof FREE_TIER_OPENER_KEYS];

/**
 * Which opener a locked session shows, from the context the caller already
 * passed. Every entry point supplies a ChatContext, so no call site changes.
 *
 * `article-suggestion` covers six surfaces (track, like, dislike, feedback
 * tree, card sheet, action row) and they deliberately collapse to ONE line: a
 * free user's answer is the same in all six, and splitting them would add
 * locale keys that say the same thing.
 */
export function openerKeyForContext(context: ChatContext): FreeTierOpenerKey {
    switch (context.kind) {
        case 'follow-story':
            return FREE_TIER_OPENER_KEYS.followStory;
        case 'article-suggestion':
            // A track tap is the one article sub-surface whose answer differs:
            // it is asking to FOLLOW, not to tune.
            return context.trackSubject
                ? FREE_TIER_OPENER_KEYS.followStory
                : FREE_TIER_OPENER_KEYS.articleFeedback;
        case 'fact-check':
            return FREE_TIER_OPENER_KEYS.factCheck;
        case 'persona':
            return FREE_TIER_OPENER_KEYS.persona;
        case 'optimisation-plan':
            return FREE_TIER_OPENER_KEYS.optimisationPlan;
        case 'generic':
            return FREE_TIER_OPENER_KEYS.tutorialHelp;
        default:
            return FREE_TIER_OPENER_KEYS.default;
    }
}
