// ONE status line for a fact check, and the rule about which one.
//
// EXTERNALS ARE THE AUTHORITY (fc-relevance wave). Mera states no verdict of
// its own on this chip, in ANY state — see `describeExternalChecks` in
// `lib/fact-check/fact-check-state.ts` for the branch selection this reads.
// That selector is the single source of truth for WHICH branch fires; this
// file only adds the organisation lead text and count on top of it. Reading
// the branch logic from two places is exactly how this chip and the panel
// drifted before (see that selector's own file header) — do not re-derive it
// here.
//
// THE ORDER (owned by `describeExternalChecks`, restated only for the reader):
//   pending         not resolved yet. Nothing to report.
//   blocked         terminal, no evidence at all. Never an answer.
//   published       one or more organisations the SERVER already gated for
//                   relevance. Their own rating, verbatim, leads. Several
//                   gets a colourless count line underneath.
//   unavailable     the ClaimReview lookup did not run — we know nothing
//                   about who has published, and must not say "nobody has".
//   none-published  we looked and nobody has published. The normal outcome
//                   for most stories, not a failure.
//
// Mera's own verdict never appears here, in any branch. It is presented,
// hedged, further down in the expanded card under "What our search found" —
// never as a ruling, never in this chip. `verdict` is therefore not a prop
// of this component any more.
//
// TONE: colourless throughout, including the organisation branch. An earlier
// version of this file kept "no red" because a chip here used to be an LLM's
// own reading, and a confident red "False" on a true story was the failure
// this feature exists to avoid. That reasoning no longer applies to THIS
// chip — Mera's reading isn't shown here at all any more — but the outcome
// still stands, for a different reason: an organisation's own words
// ("False", "Pants on Fire") already carry their full editorial weight
// verbatim, see `describeOrganisationVerdict`. Recolouring a fact-checker's
// own rating through OUR tone vocabulary would be re-editorialising a
// finding that isn't ours to grade — the same anti-pattern
// `describeOrganisationVerdict`'s own comment already rejects for the
// expanded list. So: no colour here either, on purpose, restated for this
// branch specifically now that it is the only thing this chip ever shows.

import React from 'react';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
    describeCheckedBy,
    describeExternalChecks,
    type ExternalChecksOutcome,
} from '@/lib/fact-check/fact-check-state';
import type { CheckedByStatus, FactCheckedByEntry } from '@/lib/fact-check/fact-check-types';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

export interface FactCheckBadgeProps {
    readonly status: string;
    readonly checkedBy?: readonly FactCheckedByEntry[];
    readonly checkedByStatus?: CheckedByStatus;
    /** Both halves of the testID are the CALLER's, because the two surfaces
     *  already ship different id shapes and the harness drives them by name:
     *  the card wants `fc-organisation-row1`, the panel
     *  `fact-check-0-organisation-header`. */
    readonly testIDPrefix: string;
    readonly testIDSuffix?: string;
    readonly size?: 'xs' | 'sm';
}

/**
 * What the badge says, as data — never JSX. The component below and
 * `describeBadgeStatusText` (the header accessibility label's source in
 * `FactCheckPanel`) both read from this one place, so the visible chip and
 * what a screen reader announces can never disagree about which branch fired
 * or what the lead organisation said.
 */
export interface FactCheckBadgeCopy {
    readonly outcome: ExternalChecksOutcome;
    /** Only set when `outcome === 'published'` — verbatim, never translated:
     *  an organisation's own name and rating are not our copy to localise. */
    readonly leadText?: string;
    readonly count?: number;
}

export function describeBadgeCopy(
    status: string,
    checkedBy?: readonly FactCheckedByEntry[],
    checkedByStatus?: CheckedByStatus,
): FactCheckBadgeCopy {
    const organisations = describeCheckedBy(checkedBy);
    const outcome = describeExternalChecks(status, organisations.length, checkedByStatus);
    if (outcome === 'published') {
        const lead = organisations[0];
        const leadText = lead?.verdict
            ? `${lead.organisation}: ${lead.verdict}`
            : (lead?.organisation ?? '');
        return { outcome, leadText, count: organisations.length };
    }
    return { outcome };
}

/** Plain-text form of the same decision, for composing an accessibility
 *  label — see `FactCheckPanel`'s header `Pressable`. Built on
 *  `describeBadgeCopy` so the branch selection is never re-derived. */
export function describeBadgeStatusText(
    t: TFunction,
    status: string,
    checkedBy?: readonly FactCheckedByEntry[],
    checkedByStatus?: CheckedByStatus,
): string {
    const copy = describeBadgeCopy(status, checkedBy, checkedByStatus);
    switch (copy.outcome) {
        case 'pending':
            return t('factCheck.dashboard.pending');
        case 'blocked':
            return t('factCheck.blocked');
        case 'published':
            return copy.count && copy.count > 1
                ? `${copy.leadText}. ${t('factCheck.dashboard.factChecksFound', { count: copy.count })}`
                : (copy.leadText ?? '');
        case 'unavailable':
            return t('factCheck.dashboard.couldNotCheck');
        case 'none-published':
            return t('factCheck.dashboard.noneFound');
        default:
            // Unreachable — ExternalChecksOutcome is a closed union and every
            // member is handled above. Kept for a non-exhaustive future value.
            return '';
    }
}

export const FactCheckBadge: React.FC<FactCheckBadgeProps> = ({
    status,
    checkedBy,
    checkedByStatus,
    testIDPrefix,
    testIDSuffix,
    size = 'xs',
}) => {
    const { t } = useTranslation();
    const id = (name: string) =>
        testIDSuffix ? `${testIDPrefix}-${name}-${testIDSuffix}` : `${testIDPrefix}-${name}`;

    const copy = describeBadgeCopy(status, checkedBy, checkedByStatus);

    switch (copy.outcome) {
        case 'pending':
            return (
                <Text size={size} className="text-gray-400" testID={`${testIDPrefix}-pending`}>
                    {t('factCheck.dashboard.pending')}
                </Text>
            );
        case 'blocked':
            return (
                <Text size={size} className="text-gray-400">
                    {t('factCheck.blocked')}
                </Text>
            );
        case 'published':
            return (
                <VStack space="xs" testID={id('organisation')}>
                    <Box className="self-start rounded-full bg-gray-800 px-3 py-1">
                        {/* Verbatim, on that organisation's own scale — see
                            the file header. */}
                        <Text size={size} className="font-semibold text-gray-200" numberOfLines={1}>
                            {copy.leadText}
                        </Text>
                    </Box>
                    {(copy.count ?? 0) > 1 && (
                        <Text size={size} className="text-gray-400" testID={id('count')}>
                            {t('factCheck.dashboard.factChecksFound', { count: copy.count })}
                        </Text>
                    )}
                </VStack>
            );
        case 'unavailable':
            return (
                <Text
                    size={size}
                    className="text-gray-400"
                    testID={id('unavailable')}
                    numberOfLines={2}
                >
                    {t('factCheck.dashboard.couldNotCheck')}
                </Text>
            );
        case 'none-published':
            return (
                <Text size={size} className="text-gray-400" testID={id('none-found')}>
                    {t('factCheck.dashboard.noneFound')}
                </Text>
            );
        default:
            // Unreachable — see `describeBadgeStatusText`.
            return null;
    }
};

export default FactCheckBadge;
