// The onboarding-wizard exemption from the free-tier chat gate (D29).
//
// A free user with ZERO facts must get ONE wizard run, or they can never create
// the two interests the whole product is built on and their only path to a
// working feed is paying. That is the ONLY exemption, and it is RUN-SCOPED:
// anchored to a mounted wizard, never derived from fact count.
//
// ## Why not a fact-count check
//
// It looks equivalent and is not. `fact-commit.ts` calls `addFact` and THEN
// `triggerTopicGeneration`, so by the time generation runs the user already has
// a fact and a "zero facts" marker has closed — before the work it exists to
// protect has finished. Any ambient condition has this shape. A token minted at
// the start of the run and carried through it does not.
//
// ## Why the token cannot be forged or borrowed
//
//  1. COMPILE TIME. `OnboardingRunToken`'s only member is keyed by a
//     `unique symbol` that this module never exports, so no other file can
//     write a value that satisfies the type. There is no cast-free forgery.
//  2. RUNTIME IDENTITY. Validity is membership in a module-private Set, not a
//     field on the object. A structural look-alike smuggled in through `as`
//     fails `isOnboardingRunActive`.
//  3. LIFETIME. The token is minted on mount and REVOKED on unmount, so one
//     stashed in a module variable or a store stops working the moment the
//     wizard goes away. It cannot outlive its run.
//  4. ARITY. At most one run may be live process-wide. A second mint while one
//     is active returns null rather than a second token, so a stray caller
//     cannot quietly open a parallel exemption.
//
// ## What this module deliberately does NOT decide
//
// It does not decide WHO deserves a run. That condition belongs to the routing
// in `lib/subscription/onboarding-paywall.ts`, which this module does not own,
// and which has already been evaluated by the time the wizard mounts.
//
// If you are here to "harden" this by re-deriving that condition locally —
// counting facts, reading a tier, inspecting a route — stop. That is the
// original D29 mistake in a different costume: every ambient condition that
// looks equivalent to "this is a first run" has already changed state by the
// time the guarded work executes. The credential is the token. The decision is
// upstream. Keeping those separate is the design, not an omission.

import { createContext, useContext, useEffect, useRef, useState } from 'react';

import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import logger from '@/lib/logger';
import { isChatLocked } from './free-tier-gate';

declare const ONBOARDING_RUN_BRAND: unique symbol;

/**
 * Proof that the caller is inside a live onboarding wizard run.
 *
 * Opaque by construction: the brand key is a `unique symbol` this module does
 * not export, so this type is uninhabitable from anywhere else. Pass it, never
 * build it.
 */
export interface OnboardingRunToken {
    readonly [ONBOARDING_RUN_BRAND]: true;
}

/** Tokens that are live RIGHT NOW. Identity, not shape, is the credential. */
const liveRuns = new Set<object>();

/**
 * Is this token a live run?
 *
 * `null` / `undefined` answer false, so every guard can take the optional prop
 * straight through without a null dance, and the DEFAULT is always "no
 * exemption".
 */
export function isOnboardingRunActive(
    token: OnboardingRunToken | null | undefined,
): boolean {
    return token != null && liveRuns.has(token);
}

/**
 * Mint a run token for as long as this component is mounted and `active`.
 *
 * Returns `null` when inactive, and also when another run is already live —
 * two concurrent exemptions is a bug, and handing back `null` makes it a
 * visible one rather than a widened gate.
 *
 * Intended for exactly one caller: the onboarding wizard's chat step. It is a
 * HOOK rather than a plain function so the token's lifetime is the component's
 * and cannot be extended by holding a reference.
 */
export function useOnboardingRunToken(active: boolean): OnboardingRunToken | null {
    // Identity is created once per mount, so React re-renders do not churn the
    // registry or hand out a different token mid-run.
    const tokenRef = useRef<OnboardingRunToken | null>(null);
    if (tokenRef.current === null) {
        tokenRef.current = Object.freeze({}) as unknown as OnboardingRunToken;
    }
    const token = tokenRef.current;
    const [granted, setGranted] = useState(false);

    // Subscribed, not read once. `isChatLocked()` is a plain function, so
    // without a reactive dependency the effect below would evaluate it exactly
    // once, at mount — and on a cold start that is the `'unknown'` window,
    // before the server has answered. The mint would be refused, the tier would
    // resolve to locked a moment later, and the wizard would sit there gated
    // with no exemption and no way to get one: precisely the stranded zero-fact
    // user D29 exists to rescue. Re-running when `serverTier` changes closes it.
    const serverTier = useSubscriptionStore((s) => s.serverTier);

    useEffect(() => {
        if (!active) return;
        // A token is only meaningful against a gate. If this user is not
        // actually on the free tier — genuinely entitled, or transiently
        // unresolved — there is nothing to exempt, so refusing to mint costs
        // nothing and keeps a token minted outside the free tier inert.
        if (!isChatLocked()) return;
        if (liveRuns.size > 0) {
            logger.warn('[onboarding-run] refused: a run is already live');
            return;
        }
        liveRuns.add(token);
        setGranted(true);
        return () => {
            liveRuns.delete(token);
            setGranted(false);
        };
    }, [active, token, serverTier]);

    return active && granted ? token : null;
}

/**
 * Subtree channel for the token.
 *
 * `commitFactChoices` runs from a FactChoiceCard tap, several levels below the
 * chat view and behind ChatThread's item rendering, so threading a prop would
 * mean widening three components that have no other interest in entitlement.
 * Context is scoped to the wizard's own subtree, which is the same run scope
 * the token already carries — and the value is still unforgeable, so this
 * publishes no capability that the token itself does not.
 */
export const OnboardingRunContext = createContext<OnboardingRunToken | null>(null);

/** The live run token for this subtree, or null outside a wizard run. */
export function useOnboardingRun(): OnboardingRunToken | null {
    return useContext(OnboardingRunContext);
}
