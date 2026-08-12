import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import FactCheckSources from '@/components/custom/fact-checks/FactCheckSources';
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
 * here: starting a check is `openFactCheckChat` (the action-row tick), which
 * opens the floating chat. This component only ever renders what that
 * produced.
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
                    <VStack
                        key={row.id}
                        space="sm"
                        testID={`${rowPrefix}-result`}
                        className="rounded-lg border border-gray-700 bg-gray-800/40 p-3"
                    >
                        <HStack space="xs" className="items-center">
                            <MaterialIcons name="fact-check" size={16} color={ACCENT} />
                            <Text size="sm" className="text-gray-300 font-semibold ml-1 flex-1" numberOfLines={2}>
                                {/* `row.claim` is the STORED column — populated
                                    only on a legacy per-claim row (pre-pivot
                                    on-device checks). A server (whole-article)
                                    check has no single "claim" to name — see
                                    `fact-check-types.ts` — so it falls to the
                                    generic heading. */}
                                {row.claim || t('factCheck.title')}
                            </Text>
                        </HStack>

                        {blocked ? (
                            <Text size="sm" className="text-gray-300">{t('factCheck.blocked')}</Text>
                        ) : verdictInfo ? (
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
                                        {presentation === 'lead' ? (
                                            <Box
                                                testID={`${rowPrefix}-verdict`}
                                                className={`self-start rounded-full px-3 py-1 ${TONE_CLASSES[verdictInfo.tone].chip}`}
                                            >
                                                <Text
                                                    size="sm"
                                                    className={`font-semibold ${TONE_CLASSES[verdictInfo.tone].text}`}
                                                >
                                                    {t(verdictInfo.labelKey as any)}
                                                </Text>
                                            </Box>
                                        ) : (
                                            // 'secondary' — no chip background: a
                                            // coloured pill is what reads as "the
                                            // answer", which is exactly the
                                            // competing signal this demotion
                                            // exists to remove. Plain, tone-only
                                            // text instead.
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
                                            <Text size="sm" className="text-gray-300">{payload.summary}</Text>
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
                );
            })}
        </VStack>
    );
};

export default FactCheckPanel;
