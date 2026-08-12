// ONE status line for a fact check, and the rule about which one.
//
// Extracted because two surfaces now render exactly this and must never
// disagree: the Dashboard's compact card, and the collapsed header of the
// article panel. They are the same finding at two sizes, and the previous
// version of this logic lived in the card alone — so the panel would have had
// to restate it, which is how the two drift.
//
// THE ORDER IS THE POINT, not the styling. There is room for exactly one line,
// and which one wins is a correctness question:
//
//   pending      the check has not finished. Nothing to report yet.
//   blocked      no evidence at all was found. Never a verdict.
//   organisation A recognised fact-checker published. ITS rating wins, verbatim
//                on its own scale — ours must never displace theirs (PIVOT
//                P8h). Showing "Consistent with sources" on a story Alt News
//                rated False is that defect in its smallest possible form.
//   verdict      Our own reading, when no organisation has ruled.
//   unavailable  WE COULD NOT LOOK — and this is LAST, not first.
//
// ⚠️ THE ORDER OF THOSE LAST TWO IS A CORRECTION. `unavailable` was written
// above the verdict, on the reasoning that a verdict badge implies we had
// checked everything. That is wrong, and a test caught it: `checkedByStatus`
// describes TIER 1 ONLY — whether we could see if an organisation published —
// while the verdict is TIER 2, our own reading of the evidence. An unavailable
// tier 1 must not suppress a tier 2 answer we actually have. The server already
// clamps a verdict to `unverifiable` when there is no evidence behind it, so a
// verdict shown here is a real finding, not a fabricated all-clear.
//
// The attribution gap is still told, in the body (`FactCheckSources` renders
// `factCheck.checkedByUnavailable`) and on the Dashboard card by opening it. So
// `couldNotCheck` fires only when there is genuinely nothing else to say.

import React from 'react';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import VerdictIcon from '@/components/custom/fact-checks/VerdictIcon';
import {
    describeCheckedBy,
    describeVerdict,
    describeVerdictPresentation,
    isTerminalStatus,
    type FactCheckTone,
} from '@/lib/fact-check/fact-check-state';
import type { CheckedByStatus, FactCheckedByEntry } from '@/lib/fact-check/fact-check-types';
import { useTranslation } from 'react-i18next';

/** Same rule as everywhere else in this feature: no red. See FactCheckPanel. */
const TONE_CLASSES: Record<FactCheckTone, { chip: string; text: string }> = {
    positive: { chip: 'bg-success-900', text: 'text-success-400' },
    caution: { chip: 'bg-warning-900', text: 'text-warning-400' },
    neutral: { chip: 'bg-gray-800', text: 'text-gray-300' },
};

export interface FactCheckBadgeProps {
    readonly status: string;
    readonly verdict?: string | null;
    readonly checkedBy?: readonly FactCheckedByEntry[];
    readonly checkedByStatus?: CheckedByStatus;
    /** Both halves of the testID are the CALLER's, because the two surfaces
     *  already ship different id shapes and the harness drives them by name:
     *  the card wants `fc-verdict-row1`, the panel `fact-check-0-verdict`. */
    readonly testIDPrefix: string;
    readonly testIDSuffix?: string;
    readonly size?: 'xs' | 'sm';
}

export const FactCheckBadge: React.FC<FactCheckBadgeProps> = ({
    status,
    verdict,
    checkedBy,
    checkedByStatus,
    testIDPrefix,
    testIDSuffix,
    size = 'xs',
}) => {
    const { t } = useTranslation();
    const id = (name: string) =>
        testIDSuffix ? `${testIDPrefix}-${name}-${testIDSuffix}` : `${testIDPrefix}-${name}`;

    const resolved = isTerminalStatus(status);
    const blocked = status === 'blocked';
    const organisations = describeCheckedBy(checkedBy);
    const lead = organisations[0];
    const verdictInfo = resolved && !blocked ? describeVerdict(verdict) : null;
    const presentation = describeVerdictPresentation(verdict, organisations.length);

    if (!resolved) {
        return (
            <Text size={size} className="text-gray-400" testID={`${testIDPrefix}-pending`}>
                {t('factCheck.dashboard.pending')}
            </Text>
        );
    }
    if (blocked) {
        return (
            <Text size={size} className="text-gray-400">
                {t('factCheck.blocked')}
            </Text>
        );
    }
    if (organisations.length > 0) {
        return (
            <HStack space="xs" className="items-center flex-wrap">
                <Box
                    testID={id('organisation')}
                    className="self-start rounded-full bg-gray-800 px-3 py-1"
                >
                    {/* Verbatim, on that organisation's own scale — never mapped
                        onto our five verdict values, which is the same rule the
                        server applies when it stores it. */}
                    <Text size={size} className="font-semibold text-gray-200" numberOfLines={1}>
                        {lead?.verdict ? `${lead.organisation}: ${lead.verdict}` : lead?.organisation}
                    </Text>
                </Box>
                {organisations.length > 1 && (
                    <Text size={size} className="text-gray-400">
                        {t('factCheck.dashboard.moreOrganisations', {
                            count: organisations.length - 1,
                        })}
                    </Text>
                )}
            </HStack>
        );
    }
    if (checkedByStatus === 'unavailable' && (!verdictInfo || presentation === 'suppressed')) {
        // Nothing else to report: tier 1 could not look AND there is no tier 2
        // verdict to stand in its place. Only here is "we could not check" the
        // whole of what we know.
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
    }
    if (verdictInfo && presentation !== 'suppressed') {
        return (
            <Box
                testID={id('verdict')}
                className={`self-start flex-row items-center rounded-full px-3 py-1 ${TONE_CLASSES[verdictInfo.tone].chip}`}
            >
                {/* Shield first, then the words. One tone drives both, so they
                    cannot disagree about the finding. */}
                <VerdictIcon tone={verdictInfo.tone} size={size === 'sm' ? 16 : 14} />
                <Text
                    size={size}
                    className={`font-semibold ml-1.5 ${TONE_CLASSES[verdictInfo.tone].text}`}
                >
                    {t(verdictInfo.labelKey as never)}
                </Text>
            </Box>
        );
    }
    return null;
};

export default FactCheckBadge;
