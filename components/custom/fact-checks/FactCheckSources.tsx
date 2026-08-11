import { Box } from '@/components/ui/box';
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
    readonly checkedBy?: readonly FactCheckedByEntry[] | null;
    /** Whether the ClaimReview lookup behind `checkedBy` actually ran — see
     *  `CheckedByStatus`. Undefined (a pre-tri-state stored row) is treated as
     *  `'searched'`, the only meaning an empty `checkedBy` ever had before this
     *  field existed. */
    readonly checkedByStatus?: CheckedByStatus;
    readonly citations?: readonly FactCheckCitation[] | null;
    readonly testIDPrefix: string;
}

/**
 * Everything the reader can go and read for themselves: the organisations that
 * published a fact check on this story, and the pages the search leaned on.
 *
 * ONE component, used by BOTH the article-detail panel and the Dashboard cards.
 * They previously each carried their own copy of this markup — the card had
 * `checkedBy` only and no citations at all, so half the sources were
 * unreachable depending on which surface you were looking at.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS: the disclaimer rendered right next to
 * this says "read the sources before relying on it". Until these became
 * tappable that sentence was writing a cheque the UI could not cash — it told
 * the reader to do something the app gave them no way to do. This is what makes
 * it true, which is why the source list and that sentence must stay on the same
 * view.
 *
 * Insecure or missing links are shown but NOT tappable, and say so. A link that
 * silently does nothing is worse than a label that admits it has no destination,
 * and we will not open a source over plaintext.
 */
const FactCheckSources: React.FC<FactCheckSourcesProps> = ({
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

    const organisations = describeCheckedBy(checkedBy);
    const sources = (citations ?? []).filter((c) => !!c);

    return (
        <VStack space="xs" className="mt-1" testID={`${testIDPrefix}-sources`}>
            <Text size="xs" className="text-gray-400 font-semibold uppercase">
                {t('factCheck.checkedByHeading')}
            </Text>

            {organisations.length === 0 ? (
                // TWO DIFFERENT EMPTY STATES — do not collapse them.
                // `unavailable` means the ClaimReview lookup never happened
                // (flag off, 429, transport failure): we know NOTHING about
                // who has ruled on this claim, and saying "nobody has
                // published" would be a fabricated all-clear on the one axis
                // this feature is supposed to be authoritative about.
                // `searched` (or an undefined status, from a row stored before
                // this field existed) is the normal, honest outcome — most
                // stories are never fact-checked.
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
                    {/* Never a synthesised consensus — each rating below is
                        verbatim, on that organisation's own scale, and two of
                        them can legitimately disagree. This says so rather
                        than letting a reader assume a shared heading means
                        agreement. */}
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
                    // Verbatim when unrecognised — a fact checker's published
                    // rating is human editorial copy ("Mostly False"), not a
                    // token to bucket. See describeOrganisationVerdict.
                    const info = describeOrganisationVerdict(entry.verdict);
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
                                {info.isKey ? t(info.label as any) : info.label}
                            </Text>
                            {entry.summary ? (
                                <Text size="xs" className="text-gray-400">{entry.summary}</Text>
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
                            accessibilityLabel={t('factCheck.organisationA11y', { organisation: org })}
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

            {/* Sources consulted. A COMPLETE check with zero citations is a real
                (if less useful) answer, not a gap to leave silent — without
                this branch the disclaimer below tells the reader to "read the
                sources" while none are shown and nothing acknowledges it. */}
            {sources.length === 0 ? (
                <Text
                    size="xs"
                    className="text-gray-400 mt-2"
                    testID={`${testIDPrefix}-no-citations`}
                >
                    {t('factCheck.noCitations')}
                </Text>
            ) : (
                <>
                    <Text size="xs" className="text-gray-400 font-semibold uppercase mt-2">
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
                                    <Text size="xs" className="text-gray-400" numberOfLines={3}>
                                        {citation.snippet}
                                    </Text>
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
