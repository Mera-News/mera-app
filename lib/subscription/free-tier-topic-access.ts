// The ONE rule deciding which of a free user's facts and topics are live.
//
// Mera News Free is capped access, not a wall: a free user keeps the topics
// derived from their two OLDEST persona facts, and everything else stays on the
// device, visible and intact, until a plan turns it back on. Nothing here
// deletes anything, and nothing here is persisted — see "Derived, never stored".
//
// ## Why one module owns this
//
// Three consumers ask the same question in three different places: the facts UI
// renders a badge, the Dashboard picks suggestions, and feed sync decides what
// to fetch. Three independent derivations would drift, and the drift would be
// invisible — a topic shown as live while the fetch filtered it out reads as a
// backend bug, not as a disagreement between two copies of a rule.
//
// ## Derived, never stored
//
// `deriveFreeTierAccess` re-sorts the current fact list on every call. There is
// no cached pair and no `locked` column, deliberately:
//   - The pair MOVES. Delete one of the two oldest and the next oldest becomes
//     live on the very next read. A pinned pair would need an invalidation path
//     on every fact write, which is the bug `ai-access.ts` warns about for a
//     stored `aiAccess`.
//   - A fourth `TopicStatus` would break the dedup floor in `createTopics`,
//     which is retired-exempt: a re-added topic under a new non-exempt status
//     mints a DUPLICATE row, and duplicates are independently retrieved and
//     independently billed on every feed sync.
//
// ## Naming
//
// unlocked / locked, never active / inactive. `TopicStatus` already has an
// 'active' member meaning "not suppressed or retired", and `topic-service`
// exports `getActive()` for it. The two differ for exactly the rows this module
// is about: a suppressed topic under the oldest fact is UNLOCKED here and still
// filtered downstream. Reusing the word would make `activeTopics` ambiguous at
// every call site in feed-sync.

import { useMemo } from 'react';

import { getAiAccess, useSubscriptionStore } from '@/lib/stores/subscription-store';
import { aiAccessIsServerResolved, type AiAccess } from '@/lib/subscription/ai-access';
import {
    aiAccessFromLastKnownTier,
    lastKnownTierMirror,
    readLastKnownTier,
} from '@/lib/subscription/last-known-tier';

export { hydrateLastKnownTierMirror } from '@/lib/subscription/last-known-tier';

/** How many of the user's oldest facts stay live on Mera News Free. */
export const FREE_TIER_UNLOCKED_FACT_LIMIT = 2;

/**
 * Topics minted by "Track story" carry this provenance and NO `fact_id`, so the
 * fact-age rule cannot reach them. They are exempt from the lock entirely — see
 * `isTopicUnlocked`.
 *
 * Compared as a bare string rather than importing `TopicProvenance` from the
 * WatermelonDB model: this module is imported by a scheduler task, and pulling
 * `lib/database` into that import graph is the widening `last-known-tier.ts`
 * documents breaking five unrelated Jest suites.
 */
const TRACKED_PROVENANCE = 'tracked';

/** The minimum a fact must expose to be ordered. `getFactSectionSnapshots()`
 *  already returns a superset, so no new query is needed to build these. */
export interface FactAgeInput {
    readonly id: string;
    readonly createdAtMs: number;
}

/**
 * One row that carries a topic text.
 *
 * A LIST of these is passed per topic text, not one, because the same
 * normalized text can legitimately be carried by several facts: `createTopics`
 * keys its dedup floor on `(normalized_text, fact_id)` precisely so that stays
 * possible, and `findTopicOverlapAcrossFacts` exists to detect it.
 */
export interface TopicSource {
    readonly factId: string | null | undefined;
    /** Absent on the legacy `metadata.topics` path, which has no provenance. */
    readonly provenance?: string | null;
}

export interface FreeTierAccess {
    /** True only while the cap is actually being applied. When false, both
     *  predicates below return true for everything. */
    readonly capped: boolean;
    /** The oldest `FREE_TIER_UNLOCKED_FACT_LIMIT` fact ids. Empty when uncapped. */
    readonly unlockedFactIds: ReadonlySet<string>;
    isFactUnlocked(factId: string | null | undefined): boolean;
    isTopicUnlocked(sources: readonly TopicSource[]): boolean;
}

const UNCAPPED: FreeTierAccess = {
    capped: false,
    unlockedFactIds: new Set<string>(),
    isFactUnlocked: () => true,
    isTopicUnlocked: () => true,
};

/**
 * THE rule. Pure: no store reads, no database, no React.
 *
 * Takes `AiAccess` rather than a boolean on purpose. `'unknown'` means "nobody
 * has told us yet" and must behave as UNCAPPED: treating it as locked flashes
 * Mera News Free at a paying subscriber on every cold start, which is the exact
 * failure `AiAccess`'s three-state design exists to prevent. A boolean argument
 * would collapse `'unknown'` into one of the two real answers at the call site,
 * where the mistake is invisible.
 *
 * The `FREE_TIER_MODE_ENABLED` ship gate needs no check here: with it false
 * `deriveAiAccess` already returns `'entitled'`, so this is inert behind it.
 */
export function deriveFreeTierAccess(
    aiAccess: AiAccess,
    facts: readonly FactAgeInput[],
): FreeTierAccess {
    if (aiAccess !== 'locked') return UNCAPPED;

    // Ascending by age, with `id` as a deterministic tiebreak. The tiebreak is
    // load-bearing, not defensive: `commitFactChoices` writes facts in a loop of
    // separate `database.write()` calls, so two facts saved from one card can
    // land in the same millisecond. Without it, which of them is "oldest" could
    // differ between two reads of the same unchanged table.
    const unlockedFactIds = new Set(
        [...facts]
            .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .slice(0, FREE_TIER_UNLOCKED_FACT_LIMIT)
            .map((f) => f.id),
    );

    const isFactUnlocked = (factId: string | null | undefined): boolean =>
        factId != null && unlockedFactIds.has(factId);

    return {
        capped: true,
        unlockedFactIds,
        isFactUnlocked,
        /**
         * A topic text is unlocked if ANY row carrying it is unlocked (OR, not
         * AND), or if any carrying row is a followed story.
         *
         * The `tracked` exemption is not a convenience. Those rows are minted
         * with `fact_id: null`, so the fact-age rule alone would lock every
         * story the user has chosen to follow. Two things break if it does:
         * following a story stops updating it, and `computeFreeTopicTexts`
         * derives the QUOTA-EXEMPT partition from this same set, so narrowing
         * it would start charging followed-story articles against the daily cap.
         */
        isTopicUnlocked: (sources) =>
            sources.some(
                (s) => s.provenance === TRACKED_PROVENANCE || isFactUnlocked(s.factId),
            ),
    };
}

/** Memoised `deriveFreeTierAccess` for a React surface that already holds its
 *  facts. Callers pass the ages they have; this module owns no store slice. */
export function useFreeTierAccess(
    aiAccess: AiAccess,
    facts: readonly FactAgeInput[],
): FreeTierAccess {
    return useMemo(() => deriveFreeTierAccess(aiAccess, facts), [aiAccess, facts]);
}

// ---- Which reader of entitlement, and why it matters ----------------------
//
// FOUR readers now exist and picking the wrong one fails silently:
//
//   useAiAccess()                    optimistic, for RENDERING
//   serverResolvedAiAccess()         strict + synchronous, for routing
//   resolveAiAccessForFetch()        strict + device memory, THE ENFORCEMENT one
//   aiAccessForSchedulerCondition()  synchronous mirror, conditions ONLY
//
// The optimistic reader answers `'locked'` from a cached, identified-but-empty
// RevenueCat CustomerInfo seconds before our server replies. Rendering can
// absorb that (it self-corrects within a second); a FETCH cannot, because the
// wrong answer costs a whole sync cycle and is invisible when it happens.

/**
 * `getAiAccess()`, but `'unknown'` until OUR SERVER has actually answered.
 *
 * Moved here from `onboarding-paywall.ts`, which now imports it back, so the
 * rule "a decision that routes or filters uses the server-resolved reader" has
 * one home rather than two.
 *
 * Synchronous and store-only. Use it where no `await` is possible; prefer
 * `resolveAiAccessForFetch()` anywhere that can await.
 */
export function serverResolvedAiAccess(): AiAccess {
    const { serverTier } = useSubscriptionStore.getState();
    return aiAccessIsServerResolved(serverTier) ? getAiAccess() : 'unknown';
}

/**
 * The reader for anything that FILTERS A FETCH. This is the enforcement path.
 *
 * ## The leak this closes
 *
 * On a cold start, feed sync runs BEFORE entitlement sync has answered, so
 * `serverResolvedAiAccess()` alone returns `'unknown'` and the filter fails
 * open — every free user would fetch their full unfiltered topic set once per
 * cold start. Once the free tier is live that is not a subset of users, it is
 * the entire free cohort, every launch.
 *
 * Falling back to this device's remembered tier closes it for every device that
 * has ever resolved one. A device that never has stays `'unknown'` and still
 * fails open, which is correct: that is a first-ever launch, and the server
 * grants every new account a trial, so those users genuinely are entitled.
 *
 * Trusting the memory is safe in a way a cached verdict would not be:
 * `last_known_subscription_tier` is in `FORBIDDEN_SETTING_KEYS`, so a restored
 * backup can never assert a tier from another device, and it is cleared on
 * logout and on user switch. Staleness self-heals in both directions on the
 * next successful read — and in the over-permissive direction the server is
 * still the thing enforcing, since a guarded query answers 402 and pins the
 * tier back to 'none'.
 *
 * Never throws.
 */
export async function resolveAiAccessForFetch(): Promise<AiAccess> {
    const immediate = serverResolvedAiAccess();
    if (immediate !== 'unknown') return immediate;
    return aiAccessFromLastKnownTier(await readLastKnownTier());
}

/**
 * Synchronous verdict for a scheduler `{ type: 'custom'; check: () => boolean }`.
 *
 * ## Why a synchronous mirror exists at all
 *
 * `TaskCondition.check` is synchronous. An async accessor forced into that
 * signature with a cast COMPILES, and a Promise is always truthy, so the
 * condition passes unconditionally: green types, green tests, dead gate. That
 * failure is silent, which is why this exists rather than a cast.
 * `lib/backup/backup-settings.ts` is the same pattern for the same reason.
 *
 * ## Why the mirror is safe here rather than a second source of truth
 *
 * `hydrateLastKnownTierMirror()` runs inside `hydrateAllStores()`'s
 * `Promise.all`, and `database-store.ready` flips only in that function's
 * `.finally()`. `feed-sync` carries a `db-ready` condition. So the mirror is
 * guaranteed populated before feed sync is ever ELIGIBLE to run. Without that
 * chain a bare module-level cache would be unsafe, and a future reader would be
 * right to delete it.
 *
 * It mirrors the raw TIER, never a derived `AiAccess`: the verdict sits behind
 * a ship gate and a dev override, so caching it would freeze today's derivation
 * into module state.
 *
 * ## What this is NOT
 *
 * OPTIMISATION ONLY. It spares a pointless round trip; it is not enforcement
 * and must never be the only thing between a user and content, because
 * `trigger()` bypasses conditions entirely — anything gated only here is
 * ungated on the pull-to-refresh path. Enforcement is
 * `resolveAiAccessForFetch()` INSIDE the sync.
 */
export function aiAccessForSchedulerCondition(): AiAccess {
    const immediate = serverResolvedAiAccess();
    if (immediate !== 'unknown') return immediate;
    return aiAccessFromLastKnownTier(lastKnownTierMirror());
}
