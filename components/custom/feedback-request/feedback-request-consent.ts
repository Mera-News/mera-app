// feedback-request-consent: "would ConsentGate be showing for this user?",
// asked by BOTH the auto-show host and the modal route, so every entry point
// (push tap, drawer row, auto-show) passes the same guard. The modal sends an
// answer with the account id and tier, so it must never sit above an
// unaccepted consent screen; on iOS a transparentModal presents natively and
// would cover the in-tree ConsentGate.
//
// Same predicate and helpers as ConsentGate itself, and it fails OPEN the way
// the gate does: when the versions cannot be fetched the gate does not show,
// so neither does this block. A "no consent needed" answer is cached per user
// for the process; a "needed" answer is re-asked every time (the user may
// accept at any moment), and a failed fetch is not cached.

import {
    fetchLegalVersions,
    needsConsent,
    wasLegalAcceptedThisProcess,
    type ConsentSessionUser,
} from '@/components/custom/auth/legal-consent';

let clearFor: string | null = null;

export async function consentBlocksFeedbackRequest(
    userId: string,
    user: ConsentSessionUser | null | undefined,
): Promise<boolean> {
    if (wasLegalAcceptedThisProcess(userId)) return false;
    if (clearFor === userId) return false;
    const versions = await fetchLegalVersions();
    if (!versions) return false;
    if (needsConsent(user, versions)) return true;
    clearFor = userId;
    return false;
}

/** Test seam: forget the cached answer. */
export function __resetFeedbackRequestConsentForTests(): void {
    clearFor = null;
}
