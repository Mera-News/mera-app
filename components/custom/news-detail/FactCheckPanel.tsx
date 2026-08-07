import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
    describeAssessment,
    describeVerdict,
    type FactCheckTone,
} from '@/lib/fact-check/fact-check-state';
import { useFactCheck } from '@/lib/fact-check/use-fact-check';
import type { FactCheckCitation, FactCheckClaim } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { isSecureUrl } from '@/lib/secure-url';
import { openInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

/**
 * Tone → classes. There is no red anywhere by design: an LLM verdict that
 * renders like a court judgement on a true story is the failure mode this
 * feature has to avoid, so the strongest colour available is amber "caution".
 */
const TONE_CLASSES: Record<FactCheckTone, { chip: string; text: string }> = {
    positive: { chip: 'bg-success-900', text: 'text-success-400' },
    caution: { chip: 'bg-warning-900', text: 'text-warning-400' },
    neutral: { chip: 'bg-gray-800', text: 'text-gray-300' },
};

interface FactCheckPanelProps {
    /** The ARTICLE id (not a suggestion id) — the server keys checks on it. */
    readonly articleId: string;
    readonly testIDPrefix?: string;
}

/**
 * "Fact check" action + result for an article detail screen.
 *
 * Flow: tap → `requestFactCheck` → poll `factCheck` for up to 60s. Both detail
 * routes mount this the same way; the request is idempotent and the result is
 * cached across users, so a story somebody else already checked resolves on the
 * first round trip.
 *
 * The no-spinner-flash rule is enforced HERE as well as in the hook: while the
 * check is running but `showProgress` is still false, the panel keeps rendering
 * the action button rather than an empty card. A cache hit therefore swaps the
 * button straight for the verdict, with no intermediate state and no layout
 * jump.
 *
 * Every rendered result carries the disclaimer and the citation list. Neither is
 * conditional on the verdict — a "supported" answer needs the hedge just as much
 * as an "unsupported" one, arguably more.
 */
const FactCheckPanel: React.FC<FactCheckPanelProps> = ({
    articleId,
    testIDPrefix = 'fact-check',
}) => {
    const { t } = useTranslation();
    const { phase, result, showProgress, timeoutKey, start, dismiss } = useFactCheck(articleId);

    const openCitation = useCallback((uri: string) => {
        // Citations are Google redirect wrappers, not publisher links — no UTM
        // referrer, so `openInAppBrowser` rather than `openArticleInAppBrowser`.
        // Same https requirement though; insecure ones never become tappable
        // (see the render below), this is the backstop.
        if (!isSecureUrl(uri)) return;
        openInAppBrowser(uri).catch((err) => {
            logger.captureException(err, {
                tags: { component: 'FactCheckPanel', method: 'openCitation' },
            });
        });
    }, []);

    // Working-but-not-yet-worth-a-spinner keeps the button on screen. This is
    // the whole no-flash mechanism — do not "simplify" it to `phase !== 'idle'`.
    const collapsed = phase === 'idle' || (phase === 'working' && !showProgress);

    if (collapsed) {
        return (
            <Pressable
                onPress={start}
                accessibilityRole="button"
                accessibilityLabel={t('factCheck.actionA11y')}
                testID={`${testIDPrefix}-action`}
                className="flex-row items-center justify-center rounded-lg border border-gray-700 px-4 py-3"
            >
                <MaterialIcons
                    name="fact-check"
                    size={18}
                    color={ACCENT}
                    style={{ marginRight: 8 }}
                />
                <Text size="md" className="text-primary-400 font-semibold">
                    {t('factCheck.action')}
                </Text>
            </Pressable>
        );
    }

    const verdictInfo = result ? describeVerdict(result.verdict) : null;
    const blocked = result?.status === 'blocked';
    const claims: FactCheckClaim[] = result?.claims ?? [];
    const citations: FactCheckCitation[] = result?.citations ?? [];

    return (
        <VStack
            space="sm"
            testID={`${testIDPrefix}-panel`}
            className="rounded-lg border border-gray-700 bg-gray-800/40 p-3"
        >
            <HStack className="items-center justify-between">
                <HStack space="xs" className="items-center flex-1">
                    <MaterialIcons name="fact-check" size={16} color={ACCENT} />
                    <Text size="sm" className="text-gray-300 font-semibold ml-1">
                        {t('factCheck.title')}
                    </Text>
                </HStack>
                <Pressable
                    onPress={dismiss}
                    accessibilityRole="button"
                    accessibilityLabel={t('factCheck.hide')}
                    testID={`${testIDPrefix}-hide`}
                    hitSlop={8}
                >
                    <Text size="sm" className="text-gray-400">{t('factCheck.hide')}</Text>
                </Pressable>
            </HStack>

            {phase === 'working' && (
                <HStack space="sm" className="items-center py-2">
                    <Spinner size="small" />
                    <VStack className="flex-1">
                        <Text size="sm" className="text-gray-300">{t('factCheck.checking')}</Text>
                        <Text size="xs" className="text-gray-400">{t('factCheck.checkingHint')}</Text>
                    </VStack>
                </HStack>
            )}

            {phase === 'timeout' && (
                <VStack space="sm" className="py-1">
                    <Text size="sm" className="text-gray-300">
                        {t((timeoutKey ?? 'factCheck.stillWorking') as any)}
                    </Text>
                    <Pressable onPress={start} accessibilityRole="button" testID={`${testIDPrefix}-retry`}>
                        <Text size="sm" className="text-primary-400 font-semibold">
                            {t('factCheck.retry')}
                        </Text>
                    </Pressable>
                </VStack>
            )}

            {phase === 'error' && (
                <VStack space="sm" className="py-1">
                    <Text size="sm" className="text-gray-300">{t('factCheck.error')}</Text>
                    <Pressable onPress={start} accessibilityRole="button" testID={`${testIDPrefix}-retry`}>
                        <Text size="sm" className="text-primary-400 font-semibold">
                            {t('factCheck.retry')}
                        </Text>
                    </Pressable>
                </VStack>
            )}

            {phase === 'ready' && blocked && (
                <Text size="sm" className="text-gray-300">{t('factCheck.blocked')}</Text>
            )}

            {phase === 'ready' && !blocked && verdictInfo && (
                <VStack space="sm">
                    <Box
                        testID={`${testIDPrefix}-verdict`}
                        className={`self-start rounded-full px-3 py-1 ${TONE_CLASSES[verdictInfo.tone].chip}`}
                    >
                        <Text
                            size="sm"
                            className={`font-semibold ${TONE_CLASSES[verdictInfo.tone].text}`}
                        >
                            {t(verdictInfo.labelKey as any)}
                        </Text>
                    </Box>
                    <Text size="sm" className="text-gray-300">
                        {t(verdictInfo.detailKey as any)}
                    </Text>

                    {result?.summary ? (
                        <Text size="sm" className="text-gray-300">{result.summary}</Text>
                    ) : null}

                    {claims.length > 0 && (
                        <VStack space="xs" className="mt-1">
                            <Text size="xs" className="text-gray-400 font-semibold uppercase">
                                {t('factCheck.claimsHeading')}
                            </Text>
                            {claims.map((claim, index) => {
                                const info = describeAssessment(claim.assessment);
                                return (
                                    <VStack
                                        key={`claim-${index}`}
                                        space="xs"
                                        testID={`${testIDPrefix}-claim-${index}`}
                                        className="border-l-2 border-gray-700 pl-2 py-1"
                                    >
                                        <Text size="sm" className="text-gray-200">{claim.claim}</Text>
                                        <Text
                                            size="xs"
                                            className={`font-semibold ${TONE_CLASSES[info.tone].text}`}
                                        >
                                            {t(info.labelKey as any)}
                                        </Text>
                                        {claim.note ? (
                                            <Text size="xs" className="text-gray-400">{claim.note}</Text>
                                        ) : null}
                                    </VStack>
                                );
                            })}
                        </VStack>
                    )}

                    <VStack space="xs" className="mt-1">
                        <Text size="xs" className="text-gray-400 font-semibold uppercase">
                            {t('factCheck.citationsHeading')}
                        </Text>
                        {citations.length === 0 ? (
                            <Text size="xs" className="text-gray-400">
                                {t('factCheck.noCitations')}
                            </Text>
                        ) : (
                            citations.map((citation, index) => {
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
                                    </VStack>
                                );
                                return tappable ? (
                                    <Pressable
                                        key={`citation-${index}`}
                                        onPress={() => openCitation(citation.uri)}
                                        accessibilityRole="link"
                                        accessibilityLabel={label}
                                        testID={`${testIDPrefix}-citation-${index}`}
                                        className="py-1"
                                    >
                                        {body}
                                    </Pressable>
                                ) : (
                                    // An insecure citation is shown but NOT
                                    // tappable — the reader still learns the
                                    // check leaned on it, we just refuse to
                                    // open it over plaintext.
                                    <Box
                                        key={`citation-${index}`}
                                        testID={`${testIDPrefix}-citation-${index}`}
                                        className="py-1"
                                    >
                                        {body}
                                    </Box>
                                );
                            })
                        )}
                    </VStack>

                    <Text size="xs" className="text-gray-400 mt-1">
                        {t('factCheck.disclaimer')}
                    </Text>
                </VStack>
            )}
        </VStack>
    );
};

export default FactCheckPanel;
