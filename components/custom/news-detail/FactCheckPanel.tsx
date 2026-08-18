import { Box } from '@/components/ui/box';
import { SearchCheck } from 'lucide-react-native';
import FactCheckBadge, { describeBadgeStatusText } from '@/components/custom/fact-checks/FactCheckBadge';
import { GLASS_EDGE, GlassPlate } from '@/components/custom/GlassSurface';
import { HStack } from '@/components/ui/hstack';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import FactCheckSources from '@/components/custom/fact-checks/FactCheckSources';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import {
    describeAssessment,
    isTerminalStatus,
    type FactCheckTone,
} from '@/lib/fact-check/fact-check-state';
import { useFactCheck } from '@/lib/fact-check/use-fact-check';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

/**
 * Tone → classes, for the per-claim assessment badges only. The header chip
 * is externals-only and carries no tone at all any more — see
 * `FactCheckBadge`'s own file header for why. This stays "no red" for the
 * original reason: a claim assessment is still Mera's own AI reading of one
 * claim, and a confident red badge on a claim from a true story is the
 * failure this feature exists to avoid.
 */
const TONE_CLASSES: Record<FactCheckTone, { chip: string; text: string }> = {
    positive: { chip: 'bg-success-900', text: 'text-success-400' },
    caution: { chip: 'bg-warning-900', text: 'text-warning-400' },
    neutral: { chip: 'bg-gray-800', text: 'text-gray-300' },
};

interface FactCheckPanelProps {
    readonly articleId: string | null | undefined;
    readonly testIDPrefix?: string;
}

/**
 * The article-detail fact-check block — a PURE OBSERVER of this device's
 * stored rows plus `useFactCheck`'s server poll. There is nothing to tap
 * here: starting a check is `requestArticleFactCheck` (the action-row tick),
 * which asks the server directly. This component only ever renders what that
 * produced — plus, since the `NewsArticle.factCheck` field landed, whatever
 * `mirrorArticleFactCheck` lands from a check SOMEBODY ELSE asked for.
 *
 *   absent     → render nothing. Most articles are never asked about, and most
 *                of THOSE are never fact-checked at all (~4% of the corpus is
 *                the genre fact-checkers cover) — an empty block for the
 *                overwhelming majority is the correct render, not a gap.
 *   processing → the working state, gated by `showProgress` so a check that
 *                resolves near-instantly never flashes a spinner.
 *   stalled    → the poll gave up at its ceiling without a terminal answer.
 *                MUST NOT collapse into the `absent` render (nothing) — that
 *                exact bug shipped once (r14) and had to be fixed. Renders its
 *                own honest "still checking" block instead, distinct from
 *                both "nothing" and "checked, no result" — see
 *                `factCheck.stillChecking` and `POLL_CEILING_MS`.
 *   terminal   → header chip (externals-only) → external fact checks found →
 *                Mera's own evidence → sources consulted → disclaimer, ONE
 *                CARD PER ROW. Several checks per article now stack: the
 *                user can pick more than one claim, and post-v52 each claim
 *                gets its own row and its own card.
 *
 * EXTERNALS ARE THE AUTHORITY (fc-relevance wave). Established fact-checking
 * organisations — gated for relevance to this article by the SERVER — lead
 * the card, in the collapsed chip and in the expanded body, always FIRST.
 * Mera presents no verdict of its own anywhere on this surface any more: the
 * chip is built purely from `checkedBy` / `checkedByStatus` (see
 * `FactCheckBadge`), and the expanded body's own section is headed "What our
 * search found" rather than a ruling like "Consistent with sources".
 *
 * THIS REVERSES PIVOT P8h IN THE OPPOSITE DIRECTION FROM ITS OWN FIX. P8h's
 * ranking rule (`describeVerdictPresentation` — deleted this wave, its job is
 * gone, not just its name) made an organisation's rating outrank a confident
 * Mera verdict once one existed, but still let Mera's own verdict lead the
 * chip whenever `checkedBy` was empty — and a real screenshot caught exactly
 * that leading to a false headline once: a true story, several off-topic
 * externals rated False, Mera's own well-evidenced "Consistent with sources"
 * still won the chip because it was the EXTERNALS that were actually
 * irrelevant, not absent. This wave removes Mera's verdict from the chip and
 * body ENTIRELY rather than trying to rank it against externals: the two
 * failure modes (a wrong Mera verdict heading a true story, and a
 * right-but-off-topic external heading it) share one root cause — the client
 * has no relevance signal for individual `checkedBy` entries, see
 * `fact-check-types.ts` — so removing Mera's verdict from the decision
 * surface entirely closes both at once instead of re-ranking them.
 */
const FactCheckPanel: React.FC<FactCheckPanelProps> = ({
    articleId,
    testIDPrefix = 'fact-check',
}) => {
    const { t } = useTranslation();
    const { phase, showProgress, rows } = useFactCheck(articleId);

    /**
     * Which cards the reader has expanded, keyed by row id.
     *
     * CLOSED BY DEFAULT. The header chip already carries the finding (which
     * organisations were found, or that none were) at a glance, so folding a
     * card costs nothing the reader hasn't already seen — unlike the
     * pre-badge design this comment used to describe, where collapsing hid
     * the card's only content. Keyed by id rather than index so a second
     * check arriving (rows are prepended/stacked) cannot slide the expanded
     * state onto a different card.
     *
     * Deliberately NOT persisted. This is a reading-posture preference for the
     * screen in front of you, not a setting; storing it would mean a check the
     * user expanded weeks ago is still open when they return to the article
     * having forgotten they did it. Cheap to re-expand, expensive to debug.
     */
    const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
    const toggle = React.useCallback((id: string) => {
        setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
    }, []);

    if (phase === 'absent') return null;

    const terminalRows = rows.filter((row) => isTerminalStatus(row.status));
    // The no-flash rule: a check that resolves faster than PROGRESS_DELAY_MS
    // must not flash a working indicator on its way to the verdict. If nothing
    // terminal exists yet either, and the poll hasn't stalled either, there is
    // nothing honest to render at all.
    const showWorking = phase === 'processing' && showProgress;
    const showStalled = phase === 'stalled';
    if (terminalRows.length === 0 && !showWorking && !showStalled) return null;

    return (
        <VStack space="sm" testID={`${testIDPrefix}-panel`}>
            {showStalled && (
                // Deliberately its OWN block, not a variant of the working
                // block above: the working block promises an imminent answer
                // ("this check keeps running… you don't have to wait"), which
                // is no longer an honest thing to say once the poll itself has
                // given up. This block says so plainly instead.
                <VStack
                    space="xs"
                    testID={`${testIDPrefix}-stalled`}
                    className="rounded-lg border border-gray-700 bg-gray-800/40 p-3"
                >
                    <Text size="sm" className="text-gray-300">{t('factCheck.stillChecking')}</Text>
                </VStack>
            )}

            {showWorking && (
                <VStack
                    space="xs"
                    testID={`${testIDPrefix}-working`}
                    className="rounded-lg border border-gray-700 bg-gray-800/40 p-3"
                >
                    <HStack space="sm" className="items-center">
                        <Spinner size="small" />
                        <VStack className="flex-1">
                            <Text size="sm" className="text-gray-300">{t('factCheck.checking')}</Text>
                            <Text size="xs" className="text-gray-400">{t('factCheck.explainer')}</Text>
                        </VStack>
                    </HStack>
                    {/* Device-driven reassurance: the job survives navigation
                        (module-level queue) and a kill (F2's recovery task), so
                        there is genuinely nothing to wait here for. */}
                    <Text size="xs" className="text-gray-400">{t('factCheck.queued')}</Text>
                    <Text size="xs" className="text-gray-500">{t('factCheck.queuedHint')}</Text>
                </VStack>
            )}

            {terminalRows.map((row, index) => {
                const payload = row.payload;
                const blocked = row.status === 'blocked';
                const claims = payload?.claims ?? [];
                const citations = payload?.citations ?? [];
                const checkedBy = payload?.checkedBy;
                const checkedByStatus = payload?.checkedByStatus;
                const rowPrefix = `${testIDPrefix}-${index}`;
                const isOpen = expanded[row.id] === true;
                const headerTitle = row.claim ?? t('factCheck.title');
                const badgeStatusText = describeBadgeStatusText(t, row.status, checkedBy, checkedByStatus);

                return (
                    /* GLASS, and the platform branch is the PRIMITIVE's, not
                       ours. `GlassPlate` is real Liquid Glass on iOS 26+ and a
                       flat translucent fill at the same tint everywhere else —
                       its own doc records six call sites that hand-rolled a
                       fallback and were all wrong the same way, so this one
                       does not branch.

                       The plate's parent must be UNPADDED and own the radius
                       and `overflow-hidden`: Yoga resolves an absolute child's
                       insets against the CONTENT box, so a padded parent leaves
                       an unglassed frame. Hence the outer Box here and the
                       padding on the inner VStack. */
                    <Box
                        key={row.id}
                        testID={`${rowPrefix}-result`}
                        className={`rounded-lg overflow-hidden ${GLASS_EDGE}`}
                    >
                        <GlassPlate />
                        <VStack space="sm" className="p-3">
                        {/* THE WHOLE HEADER IS THE TOGGLE, not just the chevron.
                            A verdict card is tall — organisations, our reading, every
                            claim, sources and the disclaimer — and on a phone it can
                            bury the article the reader came for. Folding it leaves
                            this one line, so the check is still visibly THERE and
                            one tap from returning; removing it outright would read
                            as the fact check having failed or disappeared. */}
                        <Pressable
                            testID={`${rowPrefix}-toggle`}
                            onPress={() => toggle(row.id)}
                            accessibilityRole="button"
                            // `expanded` is what a screen reader announces and
                            // is the only cue a non-sighted user gets that the
                            // body is foldable at all — the chevron is
                            // decorative to them.
                            accessibilityState={{ expanded: isOpen }}
                            // COMPOSED, not just the toggle verb: an explicit
                            // accessibilityLabel on a Pressable swallows every
                            // descendant Text's own announcement, so without
                            // this a screen reader heard only "Show this fact
                            // check" and never the title or the chip's finding
                            // underneath it.
                            accessibilityLabel={t('factCheck.headerA11y', {
                                title: headerTitle,
                                status: badgeStatusText,
                                action: isOpen ? t('factCheck.collapseA11y') : t('factCheck.expandA11y'),
                            })}
                            // Row height is the tap target; the chevron alone
                            // would be a ~16px one.
                            hitSlop={8}
                        >
                            <HStack space="xs" className="items-start">
                                <SearchCheck size={16} strokeWidth={2} color={ACCENT} style={{ marginTop: 2 }} />
                                {/* `row.claim` is the STORED column — populated
                                    only on a legacy per-claim row (pre-pivot
                                    on-device checks). A server (whole-article)
                                    check has no single "claim" to name — see
                                    `fact-check-types.ts` — so it falls to the
                                    generic heading, which is an i18n key and
                                    already localised, hence the plain <Text>. */}
                                {row.claim ? (
                                    <TranslatableDynamic
                                        text={row.claim}
                                        size="sm"
                                        className="text-gray-300 font-semibold ml-1 flex-1"
                                        numberOfLines={2}
                                    />
                                ) : (
                                    <Text size="sm" className="text-gray-300 font-semibold ml-1 flex-1" numberOfLines={2}>
                                        {t('factCheck.title')}
                                    </Text>
                                )}
                                {/* Externals-only, in every state — see
                                    FactCheckBadge. Capped so a long
                                    organisation name can never crowd the
                                    title off the row. */}
                                <Box className="flex-shrink max-w-[55%]">
                                    <FactCheckBadge
                                        status={row.status}
                                        checkedBy={checkedBy}
                                        checkedByStatus={checkedByStatus}
                                        testIDPrefix={rowPrefix}
                                        testIDSuffix="header"
                                    />
                                </Box>
                                <MaterialIcons
                                    name={isOpen ? 'expand-less' : 'expand-more'}
                                    size={20}
                                    color="#9CA3AF"
                                />
                            </HStack>
                        </Pressable>

                        {/* `blocked` has no body: the header badge already says
                            so, and there is nothing else to show for a check
                            that found no evidence at all. Repeating it here
                            stated one finding twice. */}
                        {!isOpen || blocked ? null : (
                            <VStack space="sm">
                                {/* EXTERNAL FACT CHECKS FIRST — they are the
                                    authority on this surface, always ahead of
                                    Mera's own evidence. Renders its own
                                    honest empty-state sentence, with no
                                    heading over it, when nothing was found —
                                    see FactCheckSources. */}
                                <FactCheckSources
                                    section="organisations"
                                    checkedBy={checkedBy}
                                    checkedByStatus={checkedByStatus}
                                    testIDPrefix={rowPrefix}
                                />

                                {/* MERA'S OWN EVIDENCE, reworded away from a
                                    ruling. `payload.summary` is Mera's own
                                    prose; the fallback below exists so this
                                    section is never blank when the search
                                    genuinely found nothing to synthesise —
                                    see F2's honest complete/every-array-empty
                                    outcome, covered in the tests. */}
                                <VStack space="sm" testID={`${rowPrefix}-own-reading`}>
                                    <Text size="xs" className="text-gray-400 font-semibold uppercase">
                                        {t('factCheck.searchFoundHeading')}
                                    </Text>
                                    {payload?.summary ? (
                                        <TranslatableDynamic
                                            text={payload.summary}
                                            size="sm"
                                            className="text-gray-300"
                                        />
                                    ) : (
                                        <Text size="sm" className="text-gray-300">
                                            {t('factCheck.searchFoundEmpty')}
                                        </Text>
                                    )}

                                    {claims.length > 0 && (
                                        <VStack space="xs" className="mt-1">
                                            <Text size="xs" className="text-gray-400 font-semibold uppercase">
                                                {t('factCheck.claimsHeading')}
                                            </Text>
                                            {claims.map((claim, claimIndex) => {
                                                const info = describeAssessment(claim.assessment);
                                                return (
                                                    <VStack
                                                        key={`claim-${claimIndex}`}
                                                        space="xs"
                                                        testID={`${rowPrefix}-claim-${claimIndex}`}
                                                        className="border-l-2 border-gray-700 pl-2 py-1"
                                                    >
                                                        <TranslatableDynamic
                                                            text={claim.claim}
                                                            size="sm"
                                                            className="text-gray-200"
                                                        />
                                                        <Text
                                                            size="xs"
                                                            className={`font-semibold ${TONE_CLASSES[info.tone].text}`}
                                                        >
                                                            {t(info.labelKey as any)}
                                                        </Text>
                                                        {claim.note ? (
                                                            <TranslatableDynamic
                                                                text={claim.note}
                                                                size="xs"
                                                                className="text-gray-400"
                                                            />
                                                        ) : null}
                                                    </VStack>
                                                );
                                            })}
                                        </VStack>
                                    )}
                                </VStack>

                                {/* Sources Mera's own search leaned on. */}
                                <FactCheckSources
                                    section="citations"
                                    citations={citations}
                                    testIDPrefix={rowPrefix}
                                />

                                <Text size="xs" className="text-gray-400 mt-1">
                                    {t('factCheck.disclaimer')}
                                </Text>
                            </VStack>
                        )}
                        </VStack>
                    </Box>
                );
            })}
        </VStack>
    );
};

export default FactCheckPanel;
