import { Box } from '@/components/ui/box';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { CheckedByStatus, FactCheckedByEntry, FactCheckCitation } from '@/lib/fact-check/fact-check-types';
import {
    describeCheckedBy,
    describeOrganisationVerdict,
    shouldShowMultipleOrganisationsCaveat,
    type FactCheckTone,
} from '@/lib/fact-check/fact-check-state';
import logger from '@/lib/logger';
import { isSecureUrl } from '@/lib/secure-url';
import { openInAppBrowser } from '@/lib/web-browser-utils';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/** Same rule as everywhere else in this feature: no red. See FactCheckPanel. */
const TONE_CLASSES: Record<FactCheckTone, { text: string }> = {
    positive: { text: 'text-success-400' },
    caution: { text: 'text-warning-400' },
    neutral: { text: 'text-gray-300' },
};

interface FactCheckSourcesProps {
    /** Which half to render — see the file header. */
    readonly section: 'organisations' | 'citations';
    readonly checkedBy?: readonly FactCheckedByEntry[] | null;
    /** Whether the ClaimReview lookup behind `checkedBy` actually ran — see
     *  `CheckedByStatus`. Undefined (a pre-tri-state stored row) is treated as
     *  `'searched'`, the only meaning an empty `checkedBy` ever had before
     *  this field existed. Only read when `section === 'organisations'`. */
    readonly checkedByStatus?: CheckedByStatus;
    readonly citations?: readonly FactCheckCitation[] | null;
    readonly testIDPrefix: string;
}

/**
 * Everything the reader can go and read for themselves, split into two
 * sections by the `section` prop so `FactCheckPanel` can place them apart:
 * the organisations (the authority on this surface, rendered FIRST in the
 * card) and the citations Mera's own search leaned on (rendered lower, next
 * to Mera's own reading).
 *
 * SINGLE CONSUMER. `FactCheckPanel.tsx` is the only importer — verified by
 * grep, not assumed. (An earlier version of this file claimed Dashboard reuse
 * too; that stopped being true once the Dashboard card moved to a
 * self-contained badge plus a plain organisation-name line, see
 * `FactCheckCard.tsx`.) If a second consumer shows up, restate that here
 * rather than letting the claim go stale again.
 *
 * `section="organisations"`: THE HEADING RENDERS ONLY WHEN THE LIST IS
 * NON-EMPTY. An empty result is real and common (~96% of the corpus) and
 * gets its own honest sentence with no "found" heading sitting above it —
 * shipping a heading over an empty list was a review blocker on this wave's
 * mockup. The relatedness hedge (`checkedByRelatedNote`) is new this wave:
 * these organisations are gated for relevance to the article server-side,
 * but the client still cannot show WHICH claim a rating is actually about,
 * so the hedge stays regardless of how many are listed.
 *
 * `section="citations"`: unchanged in shape from before this wave — a
 * COMPLETE check with zero citations is a real (if less useful) answer, not
 * a gap to leave silent.
 *
 * Insecure or missing links are shown but NOT tappable, and say so. A link
 * that silently does nothing is worse than a label that admits it has no
 * destination, and we will not open a source over plaintext.
 */
const FactCheckSources: React.FC<FactCheckSourcesProps> = ({
    section,
    checkedBy,
    checkedByStatus,
    citations,
    testIDPrefix,
}) => {
    const { t } = useTranslation();

    // The single way this feature opens a URL. `openInAppBrowser`, not
    // `openArticleInAppBrowser`: these are third-party pages, not our
    // publishers, so they carry no UTM referrer.
    const openSource = useCallback((uri: string) => {
        if (!isSecureUrl(uri)) return;
        openInAppBrowser(uri).catch((err) => {
            logger.captureException(err, {
                tags: { component: 'FactCheckSources', method: 'openSource' },
            });
        });
    }, []);

    if (section === 'organisations') {
        const organisations = describeCheckedBy(checkedBy);
        return (
            <VStack space="xs" testID={`${testIDPrefix}-checked-by`}>
                {organisations.length === 0 ? (
                    // TWO DIFFERENT EMPTY STATES — do not collapse them.
                    // `unavailable` means the ClaimReview lookup never
                    // happened (flag off, 429, transport failure): we know
                    // NOTHING about who has ruled, and saying "nobody has
                    // published" would be a fabricated all-clear on the one
                    // axis this feature is supposed to be authoritative
                    // about. `searched` (or an undefined status, from a row
                    // stored before this field existed) is the normal,
                    // honest outcome — most stories are never fact-checked.
                    checkedByStatus === 'unavailable' ? (
                        <Text size="xs" className="text-gray-400" testID={`${testIDPrefix}-checked-by-unavailable`}>
                            {t('factCheck.checkedByUnavailable')}
                        </Text>
                    ) : (
                        <Text size="xs" className="text-gray-400">
                            {t('factCheck.noCheckedBy')}
                        </Text>
                    )
                ) : (
                    <>
                        <Text size="xs" className="text-gray-400 font-semibold uppercase">
                            {t('factCheck.checkedByHeading')}
                        </Text>
                        <Text size="xs" className="text-gray-400">
                            {t('factCheck.checkedByRelatedNote')}
                        </Text>
                        {/* Never a synthesised consensus — each rating below
                            is verbatim, on that organisation's own scale, and
                            two of them can legitimately disagree. */}
                        {shouldShowMultipleOrganisationsCaveat(organisations.length) && (
                            <Text
                                size="xs"
                                className="text-gray-400 italic"
                                testID={`${testIDPrefix}-multiple-organisations-note`}
                            >
                                {t('factCheck.checkedByMultipleNote')}
                            </Text>
                        )}
                        {organisations.map((entry, index) => {
                            const org = entry.organisation.trim();
                            // Verbatim when unrecognised — a fact checker's
                            // published rating is human editorial copy
                            // ("Mostly False"), not a token to bucket. See
                            // describeOrganisationVerdict.
                            const info = describeOrganisationVerdict(entry.verdict);
                            const ratingText = info.isKey ? t(info.label as any) : info.label;
                            const tappable = isSecureUrl(entry.url ?? '');
                            const body = (
                                <VStack space="xs">
                                    <Text
                                        size="sm"
                                        className={tappable
                                            ? 'text-primary-400 underline font-semibold'
                                            : 'text-gray-200 font-semibold'}
                                    >
                                        {org}
                                    </Text>
                                    <Text
                                        size="xs"
                                        className={`font-semibold ${TONE_CLASSES[info.tone].text}`}
                                    >
                                        {ratingText}
                                    </Text>
                                    {/* The organisation's own one-line
                                        description — prose, so it is
                                        translated. Name and verbatim rating
                                        above are deliberately NOT: a rating is
                                        a quote on that organisation's own
                                        scale, and machine-translating "Pants
                                        on Fire" re-words the very thing the
                                        server stores verbatim precisely so it
                                        cannot be re-worded. */}
                                    {entry.summary ? (
                                        <TranslatableDynamic
                                            text={entry.summary}
                                            size="xs"
                                            className="text-gray-400"
                                        />
                                    ) : null}
                                    {!tappable ? (
                                        <Text size="xs" className="text-gray-500 italic">
                                            {t('factCheck.noLink')}
                                        </Text>
                                    ) : null}
                                </VStack>
                            );
                            return tappable ? (
                                <Pressable
                                    key={`org-${index}`}
                                    onPress={() => openSource(entry.url as string)}
                                    accessibilityRole="link"
                                    accessibilityLabel={t('factCheck.organisationA11y', {
                                        organisation: org,
                                        rating: ratingText,
                                    })}
                                    testID={`${testIDPrefix}-org-${index}`}
                                    className="border-l-2 border-gray-700 pl-2 py-1"
                                >
                                    {body}
                                </Pressable>
                            ) : (
                                <Box
                                    key={`org-${index}`}
                                    testID={`${testIDPrefix}-org-${index}`}
                                    className="border-l-2 border-gray-700 pl-2 py-1"
                                >
                                    {body}
                                </Box>
                            );
                        })}
                    </>
                )}
            </VStack>
        );
    }

    // section === 'citations'
    const sources = (citations ?? []).filter((c) => !!c);
    return (
        <VStack space="xs" className="mt-1" testID={`${testIDPrefix}-citations`}>
            {/* A COMPLETE check with zero citations is a real (if less
                useful) answer, not a gap to leave silent — without this
                branch the disclaimer below tells the reader to "read the
                sources" while none are shown and nothing acknowledges it. */}
            {sources.length === 0 ? (
                <Text
                    size="xs"
                    className="text-gray-400"
                    testID={`${testIDPrefix}-no-citations`}
                >
                    {t('factCheck.noCitations')}
                </Text>
            ) : (
                <>
                    <Text size="xs" className="text-gray-400 font-semibold uppercase">
                        {t('factCheck.citationsHeading')}
                    </Text>
                    {sources.map((citation, index) => {
                        const label = citation.title?.trim()
                            || t('factCheck.sourceFallback', { index: index + 1 });
                        const tappable = isSecureUrl(citation.uri);
                        const body = (
                            <VStack space="xs">
                                <Text
                                    size="sm"
                                    className={tappable
                                        ? 'text-primary-400 underline'
                                        : 'text-gray-400'}
                                >
                                    {label}
                                </Text>
                                {citation.snippet ? (
                                    <TranslatableDynamic
                                        text={citation.snippet}
                                        size="xs"
                                        className="text-gray-400"
                                        numberOfLines={3}
                                    />
                                ) : null}
                                {!tappable ? (
                                    <Text size="xs" className="text-gray-500 italic">
                                        {t('factCheck.noLink')}
                                    </Text>
                                ) : null}
                            </VStack>
                        );
                        return tappable ? (
                            <Pressable
                                key={`citation-${index}`}
                                onPress={() => openSource(citation.uri)}
                                accessibilityRole="link"
                                accessibilityLabel={t('factCheck.citationA11y', { source: label })}
                                testID={`${testIDPrefix}-citation-${index}`}
                                className="py-1"
                            >
                                {body}
                            </Pressable>
                        ) : (
                            <Box
                                key={`citation-${index}`}
                                testID={`${testIDPrefix}-citation-${index}`}
                                className="py-1"
                            >
                                {body}
                            </Box>
                        );
                    })}
                </>
            )}
        </VStack>
    );
};

export default FactCheckSources;
