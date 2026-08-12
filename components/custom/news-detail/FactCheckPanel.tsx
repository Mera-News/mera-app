import { Box } from '@/components/ui/box';
import { SearchCheck } from 'lucide-react-native';
import FactCheckBadge from '@/components/custom/fact-checks/FactCheckBadge';
import { GLASS_EDGE, GlassPlate } from '@/components/custom/GlassSurface';
import { HStack } from '@/components/ui/hstack';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import FactCheckSources from '@/components/custom/fact-checks/FactCheckSources';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import {
    describeAssessment,
    describeCheckedBy,
    describeVerdict,
    describeVerdictPresentation,
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
 *   terminal   → verdict chip → summary → claims → `FactCheckSources` →
 *                disclaimer, ONE CARD PER ROW. Several checks per article now
 *                stack: the user can pick more than one claim, and post-v52
 *                each claim gets its own row and its own card.
 *
 * `checkedBy` — the organisations, each with its own verdict and a link — is
 * the primary answer; the AI summary is context around it. An EMPTY
 * `checkedBy` is the normal outcome for most stories, not a failure: see
 * `factCheck.noCheckedBy`.
 *
 * PIVOT P8h — WHEN checkedBy IS POPULATED, IT LEADS, NOT OUR OWN VERDICT
 * CHIP. A real screenshot caught a green "Consistent with sources" chip
 * sitting directly above "No fact-checking organisation we searched has
 * published on this story" — a confident verdict on zero evidence, "the
 * failure mode that looks exactly like success" per the server's own
 * `clampVerdictToEvidence` comment. The server now clamps that at write
 * time, but a row can still legitimately arrive `verdict: 'unverifiable'`
 * WITH a populated `checkedBy` (the re-check path: nothing found on day 0,
 * clamped; a fact-checker publishes on day 2, `checkedBy` fills in, the
 * verdict is deliberately NOT re-opened — see `describeVerdictPresentation`).
 * "Couldn't confirm" next to a named organisation's own rating is the same
 * contradiction, one hop later. So: `checkedBy` populated ⇒ `FactCheckSources`
 * renders FIRST, and our own verdict chip is either demoted (a plain,
 * relabelled line under "Mera's own reading") or suppressed outright when it
 * is `'unverifiable'` — see `describeVerdictPresentation`'s own reasoning for
 * why suppression, not just demotion, is correct there.
 */
const FactCheckPanel: React.FC<FactCheckPanelProps> = ({
    articleId,
    testIDPrefix = 'fact-check',
}) => {
    const { t } = useTranslation();
    const { phase, showProgress, rows } = useFactCheck(articleId);

    /**
     * Which cards the reader has folded away, keyed by row id.
     *
     * OPEN BY DEFAULT, and absence means open — a result the user asked for
     * should never arrive already hidden. Keyed by id rather than index so a
     * second check arriving (rows are prepended/stacked) cannot slide the
     * collapsed state onto a different card.
     *
     * Deliberately NOT persisted. This is a reading-posture preference for the
     * screen in front of you, not a setting; storing it would mean a check the
     * user collapsed weeks ago is still hidden when they return to the article
     * having forgotten they did it, which reads as the fact check having
     * vanished. Cheap to re-collapse, expensive to debug.
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
                // `verdict` is read from the mirrored COLUMN, not the payload —
                // it stays available even if `payload_json` failed to parse
                // (the service degrades that to "we know a check exists, we
                // just can't render its detail").
                const verdictInfo = !blocked ? describeVerdict(row.verdict) : null;
                const claims = payload?.claims ?? [];
                const citations = payload?.citations ?? [];
                const checkedBy = payload?.checkedBy;
                const checkedByStatus = payload?.checkedByStatus;
                const rowPrefix = `${testIDPrefix}-${index}`;
                const isOpen = expanded[row.id] === true;
                // See the file header (PIVOT P8h) — an organisation's own
                // rating leads once one exists; ours never competes with it.
                const organisationCount = describeCheckedBy(checkedBy).length;
                const hasCheckedBy = organisationCount > 0;
                const presentation = describeVerdictPresentation(row.verdict, organisationCount);
                const sources = (
                    <FactCheckSources
                        checkedBy={checkedBy}
                        checkedByStatus={checkedByStatus}
                        citations={citations}
                        testIDPrefix={rowPrefix}
                    />
                );

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
                            A verdict card is tall — organisations, summary, per
                            claim assessments, sources, disclaimer — and on a
                            phone it can bury the article the reader came for.
                            Folding it leaves this one line, so the check is
                            still visibly THERE and one tap from returning;
                            removing it outright would read as the fact check
                            having failed or disappeared. */}
                        <Pressable
                            testID={`${rowPrefix}-toggle`}
                            onPress={() => toggle(row.id)}
                            accessibilityRole="button"
                            // `expanded` is what a screen reader announces and
                            // is the only cue a non-sighted user gets that the
                            // body is foldable at all — the chevron is
                            // decorative to them.
                            accessibilityState={{ expanded: isOpen }}
                            accessibilityLabel={
                                isOpen ? t('factCheck.collapseA11y') : t('factCheck.expandA11y')
                            }
                            // Row height is the tap target; the chevron alone
                            // would be a ~16px one.
                            hitSlop={8}
                        >
                            <HStack space="xs" className="items-center">
                                <SearchCheck size={16} strokeWidth={2} color={ACCENT} />
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
                                {/* The finding itself, on the header line, so a
                                    closed card still answers the question. Same
                                    component the Dashboard card uses — which
                                    badge wins is a correctness rule, not
                                    styling, and it must not be restated here.
                                    See FactCheckBadge. */}
                                <FactCheckBadge
                                    status={row.status}
                                    verdict={row.verdict}
                                    checkedBy={checkedBy}
                                    checkedByStatus={checkedByStatus}
                                    testIDPrefix={rowPrefix}
                                    testIDSuffix="header"
                                />
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
                        {!isOpen || blocked ? null : verdictInfo ? (
                            <VStack space="sm">
                                {/* checkedBy LEADS when populated — see the file
                                    header (PIVOT P8h). Positioned above our own
                                    reading rather than the other way around, so
                                    the organisation's own verbatim rating is the
                                    first thing read, not a chip that may
                                    contradict it further down. */}
                                {hasCheckedBy && sources}

                                {presentation !== 'suppressed' && (
                                    <VStack
                                        space="sm"
                                        testID={hasCheckedBy ? `${rowPrefix}-own-reading` : undefined}
                                    >
                                        {hasCheckedBy && (
                                            <Text size="xs" className="text-gray-400 font-semibold uppercase">
                                                {t('factCheck.ownReadingHeading')}
                                            </Text>
                                        )}
                                        {/* NO CHIP HERE WHEN OURS IS THE LEAD —
                                            the header badge already carries it,
                                            and the same finding stated twice on
                                            one card reads as two findings. The
                                            'secondary' case DOES still render:
                                            there the header shows the
                                            ORGANISATION's rating, so this is a
                                            different statement, deliberately
                                            demoted to plain tone-only text under
                                            its own heading. */}
                                        {presentation === 'secondary' && (
                                            <Text
                                                size="sm"
                                                testID={`${rowPrefix}-verdict-secondary`}
                                                className={`font-semibold ${TONE_CLASSES[verdictInfo.tone].text}`}
                                            >
                                                {t(verdictInfo.labelKey as any)}
                                            </Text>
                                        )}
                                        <Text size="sm" className="text-gray-300">
                                            {t(verdictInfo.detailKey as any)}
                                        </Text>

                                        {payload?.summary ? (
                                            <TranslatableDynamic
                                                text={payload.summary}
                                                size="sm"
                                                className="text-gray-300"
                                            />
                                        ) : null}

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
                                )}

                                {/* WHO CHECKED IT, and everything the reader can
                                    go read for themselves. Shared with the
                                    Dashboard cards (FactCheckSources) so the two
                                    surfaces cannot drift. It sits directly above
                                    the disclaimer on purpose: that sentence
                                    tells the reader to read the sources before
                                    relying on it, which is only true once these
                                    are tappable. When checkedBy is empty this is
                                    its ORIGINAL position (unchanged); when
                                    populated it already rendered above, first. */}
                                {!hasCheckedBy && sources}

                                <Text size="xs" className="text-gray-400 mt-1">
                                    {t('factCheck.disclaimer')}
                                </Text>
                            </VStack>
                        ) : null}
                        </VStack>
                    </Box>
                );
            })}
        </VStack>
    );
};

export default FactCheckPanel;
