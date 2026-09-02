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
// What this deliberately does NOT do is decide WHO deserves a run. That is the
// routing decision in `lib/subscription/onboarding-paywall.ts`, which is the
// persona area's, and it has already been made by the time the wizard mounts.

import { createContext, useContext, useEffect, useRef, useState } from 'react';

import logger from '@/lib/logger';

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

    useEffect(() => {
        if (!active) return;
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
    }, [active, token]);

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
