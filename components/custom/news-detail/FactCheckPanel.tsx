import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
    describeAssessment,
    describeCheckedBy,
    describeOrganisationVerdict,
    describeVerdict,
    type FactCheckTone,
} from '@/lib/fact-check/fact-check-state';
import type { FactCheckedByEntry } from '@/lib/fact-check/fact-check-service';
import { useFactCheck } from '@/lib/fact-check/use-fact-check';
import type { FactCheckCitation, FactCheckClaim } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { isSecureUrl } from '@/lib/secure-url';
import { useFactCheckEnabled } from '@/lib/stores/mera-protocol-store';
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
    /** Headline, stored with the result so the Fact checks list can name the
     *  story after the article row itself has aged out server-side. */
    readonly articleTitle?: string | null;
    readonly testIDPrefix?: string;
}

/**
 * "Look for fact checks" action + result for an article detail screen.
 *
 * WHAT THIS ACTUALLY DOES, because the old copy claimed otherwise: Mera does not
 * fact-check the news. It asks the server to search for fact checks that
 * established organisations have already published on the story, and reports
 * who said what. `checkedBy` — the organisations, each with its own verdict and
 * a link — is the primary answer; the AI summary is context around it.
 *
 * Flow: tap → `requestFactCheck` → render. There is NO poll. A story somebody
 * else already checked comes back complete on that first call; anything else
 * resolves in the background and lands in the on-device `fact_checks` table via
 * a push, so the panel says so and stops rather than holding the reader on the
 * screen behind a spinner with a made-up deadline.
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
    articleTitle = null,
    testIDPrefix = 'fact-check',
}) => {
    const { t } = useTranslation();
    const factCheckEnabled = useFactCheckEnabled();
    // `enabled` is threaded in rather than relying on the early return below:
    // the return happens AFTER this call (hook order must not change), so the
    // hook's mount read would otherwise fire on every article open for a user
    // who has the feature off — and the resolvers sit behind SubscriptionGuard.
    const { phase, result, showProgress, refreshing, start, refresh, dismiss } =
        useFactCheck(articleId, {
            enabled: factCheckEnabled,
            articleTitle,
        });

    const openSource = useCallback((uri: string) => {
        // Citations are Google redirect wrappers, not publisher links — no UTM
        // referrer, so `openInAppBrowser` rather than `openArticleInAppBrowser`.
        // Same https requirement though; insecure ones never become tappable
        // (see the render below), this is the backstop.
        if (!isSecureUrl(uri)) return;
        openInAppBrowser(uri).catch((err) => {
            logger.captureException(err, {
                tags: { component: 'FactCheckPanel', method: 'openSource' },
            });
        });
    }, []);

    // UX gate only — BETA, off by default (see mera-protocol-store.ts). This
    // does NOT gate the server: `requestFactCheck`/`factCheck` stay behind
    // SubscriptionGuard regardless (fact-check.resolver.ts:22,38). Placed
    // after every hook above so hook order never changes across renders;
    // `useFactCheck`'s own mount effects only reset local state — no network,
    // no timers until `start()` — so calling and discarding it here is free.
    if (!factCheckEnabled) return null;

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
    // The organisations that actually published a fact check on this story —
    // the headline answer, rendered above the AI's own summary. Absent whenever
    // the server predates `checkedBy` (see CHECKED_BY_SELECTION in
    // fact-check-service), which degrades to the "nobody covered it" line
    // rather than to a crash.
    const checkedBy: FactCheckedByEntry[] = describeCheckedBy(result?.checkedBy);

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
                        <Text size="xs" className="text-gray-400">{t('factCheck.explainer')}</Text>
                    </VStack>
                </HStack>
            )}

            {/* Queued — the honest end of a non-instant request. No spinner, no
                retry: there is nothing to retry (the request is lodged and the
                server has a retry cron of its own) and nothing on this screen
                for the reader to wait for. */}
            {phase === 'queued' && (
                <VStack space="xs" className="py-1" testID={`${testIDPrefix}-queued`}>
                    <Text size="sm" className="text-gray-300">
                        {t('factCheck.queued')}
                    </Text>
                    <Text size="xs" className="text-gray-400">
                        {t('factCheck.queuedHint')}
                    </Text>
                    {/* The manual path to a result. Not a retry of the REQUEST
                        (that is already lodged) — a single re-read of it. It
                        exists because the push is otherwise the only way an
                        answer can arrive, and a reader with notifications
                        denied, no token, or a dropped send would otherwise sit
                        on "still searching" with nothing they can do. */}
                    <Pressable
                        onPress={refresh}
                        disabled={refreshing}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: refreshing }}
                        testID={`${testIDPrefix}-refresh`}
                        hitSlop={8}
                        className="pt-1"
                    >
                        <Text
                            size="sm"
                            className={refreshing
                                ? 'text-gray-500 font-semibold'
                                : 'text-primary-400 font-semibold'}
                        >
                            {t('factCheck.checkAgain')}
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

                    {/* WHO CHECKED IT — the primary answer, above the AI's own
                        prose. Every organisation is listed, each with its own
                        verdict and its own link; the reader's question is
                        "which fact-checkers looked at this and what did they
                        conclude", and collapsing that to one aggregate verdict
                        throws away the only part of this feature that isn't a
                        model's opinion. */}
                    <VStack space="xs" className="mt-1" testID={`${testIDPrefix}-checked-by`}>
                        <Text size="xs" className="text-gray-400 font-semibold uppercase">
                            {t('factCheck.checkedByHeading')}
                        </Text>
                        {checkedBy.length === 0 ? (
                            <Text size="xs" className="text-gray-400">
                                {t('factCheck.noCheckedBy')}
                            </Text>
                        ) : (
                            checkedBy.map((entry, index) => {
                                const org = entry.organisation.trim();
                                // NOT describeAssessment: an organisation's own
                                // rating ("Mostly False", "Altered photo") is
                                // human editorial copy and is shown verbatim
                                // when we don't recognise it. Bucketing it as
                                // "Unclear" would delete the very thing the
                                // reader came for.
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
                                            <Text size="xs" className="text-gray-400">
                                                {entry.summary}
                                            </Text>
                                        ) : null}
                                    </VStack>
                                );
                                return tappable ? (
                                    <Pressable
                                        key={`checked-by-${index}`}
                                        onPress={() => openSource(entry.url as string)}
                                        accessibilityRole="link"
                                        accessibilityLabel={t('factCheck.organisationA11y', { organisation: org })}
                                        testID={`${testIDPrefix}-checked-by-${index}`}
                                        className="border-l-2 border-gray-700 pl-2 py-1"
                                    >
                                        {body}
                                    </Pressable>
                                ) : (
                                    // Same rule as the citations below: an
                                    // organisation with no https link is still
                                    // named — the reader learns who covered it —
                                    // it just isn't openable over plaintext.
                                    <Box
                                        key={`checked-by-${index}`}
                                        testID={`${testIDPrefix}-checked-by-${index}`}
                                        className="border-l-2 border-gray-700 pl-2 py-1"
                                    >
                                        {body}
                                    </Box>
                                );
                            })
                        )}
                    </VStack>

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
                                        onPress={() => openSource(citation.uri)}
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
