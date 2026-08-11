import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import FactCheckSources from '@/components/custom/fact-checks/FactCheckSources';
import type { CheckedByStatus, FactCheckedByEntry, FactCheckCitation } from '@/lib/fact-check/fact-check-types';
import {
    describeCheckedBy,
    describeVerdict,
    describeVerdictPresentation,
    isTerminalStatus,
    type FactCheckTone,
} from '@/lib/fact-check/fact-check-state';
import type { StoredFactCheck } from '@/lib/database/services/fact-check-record-service';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

/** Same rule as the detail panel: no red, ever. See FactCheckPanel. */
const TONE_CLASSES: Record<FactCheckTone, { chip: string; text: string }> = {
    positive: { chip: 'bg-success-900', text: 'text-success-400' },
    caution: { chip: 'bg-warning-900', text: 'text-warning-400' },
    neutral: { chip: 'bg-gray-800', text: 'text-gray-300' },
};

interface FactCheckCardProps {
    readonly item: StoredFactCheck;
    /** Tapping the card body. Omit to render a non-interactive card (the
     *  article-detail "no longer available" state passes nothing — the reader
     *  is already as far in as the story goes). */
    readonly onPress?: (item: StoredFactCheck) => void;
    /** Rendered top-right, over the body. The list passes a delete control. */
    readonly onDelete?: (id: string) => void;
    readonly testIDPrefix?: string;
}

/**
 * One stored fact check, as it appears on the Dashboard block and the
 * /logged-in/fact-checks list.
 *
 * The card's job is to answer "who checked this story, and what did they say" —
 * so EVERY organisation in `checkedBy` is listed, each with its own verdict and
 * its own tappable link. Collapsing them to a single aggregate verdict is
 * exactly what this card must not do: the aggregate is the model's reading, the
 * per-organisation rows are the actual reporting.
 *
 * A row whose check has not finished yet renders as "still searching" rather
 * than being hidden — the user asked for it, and a request that vanishes from
 * every surface until it completes is indistinguishable from one that was
 * dropped.
 *
 * PIVOT P8h — same rule as `FactCheckPanel`: once `checkedBy` is populated,
 * an organisation's own rating leads and our verdict chip is demoted
 * ('secondary', plain text under a relabelled heading) or suppressed
 * outright when it is `'unverifiable'` (see `describeVerdictPresentation`) —
 * "Couldn't confirm" next to a named organisation's own rating is not a
 * hedge, it is wrong.
 */
const FactCheckCard: React.FC<FactCheckCardProps> = ({
    item,
    onPress,
    onDelete,
    testIDPrefix = 'fact-check-card',
}) => {
    const { t } = useTranslation();

    const resolved = isTerminalStatus(item.status);
    const blocked = item.status === 'blocked';
    const verdictInfo = resolved && !blocked ? describeVerdict(item.verdict) : null;
    const checkedBy = (item.payload as { checkedBy?: FactCheckedByEntry[] } | null)?.checkedBy;
    const checkedByStatus = (item.payload as { checkedByStatus?: CheckedByStatus } | null)?.checkedByStatus;
    const citations = (item.payload as { citations?: FactCheckCitation[] } | null)?.citations;
    const organisationCount = describeCheckedBy(checkedBy).length;
    const hasCheckedBy = organisationCount > 0;
    const presentation = describeVerdictPresentation(item.verdict, organisationCount);
    const sources = resolved && !blocked ? (
        <FactCheckSources
            checkedBy={checkedBy}
            checkedByStatus={checkedByStatus}
            citations={citations}
            testIDPrefix={testIDPrefix}
        />
    ) : null;

    return (
        // The delete control is a SIBLING of the tappable body, absolutely
        // positioned over its top-right corner — not a child of it.
        //
        // Nesting it inside the card's Pressable is the classic bug in this
        // pattern: RN's responder system usually lets the inner Pressable win,
        // but "usually" is doing real work there, and the failure mode (delete
        // ALSO navigates, so the row vanishes as a detail screen opens over it)
        // is both destructive and confusing. Sibling + absolute makes it
        // structural rather than a behaviour to hope for. The title row carries
        // `pr-8` so a long headline can never run under the icon, and hitSlop
        // keeps the target at ~44pt on a narrow screen.
        <Box testID={`${testIDPrefix}-${item.id}`} className="relative">
            <Pressable
                onPress={onPress ? () => onPress(item) : undefined}
                disabled={!onPress}
                accessibilityRole={onPress ? 'button' : undefined}
                accessibilityLabel={onPress ? t('factCheck.dashboard.openA11y') : undefined}
                testID={`${testIDPrefix}-open-${item.id}`}
                className="rounded-lg border border-gray-700 bg-gray-800/40 p-3"
            >
                <VStack space="sm">
            <HStack space="xs" className="items-start pr-8">
                    <MaterialIcons
                        name="fact-check"
                        size={16}
                        color={ACCENT}
                        style={{ marginTop: 2 }}
                    />
                    <Text size="sm" className="text-gray-100 font-semibold flex-1 ml-1" numberOfLines={3}>
                        {item.articleTitle?.trim() || t('factCheck.dashboard.untitled')}
                    </Text>
            </HStack>

            {/* The claim this ROW is about. An article can carry several rows
                post-v52 (one per claim the user picked) — without this line
                two rows for the same headline are indistinguishable except by
                their verdict. Absent on a legacy (pre-v52) whole-article row. */}
            {item.claim ? (
                <Text size="xs" className="text-gray-400 italic" numberOfLines={2}>
                    {item.claim}
                </Text>
            ) : null}

            {!resolved && (
                <Text size="xs" className="text-gray-400" testID={`${testIDPrefix}-pending`}>
                    {t('factCheck.dashboard.pending')}
                </Text>
            )}

            {blocked && (
                <Text size="xs" className="text-gray-400">{t('factCheck.blocked')}</Text>
            )}

            {/* checkedBy LEADS when populated — see the file header (PIVOT
                P8h). Above the verdict rather than below it, so an
                organisation's own rating is read first. */}
            {hasCheckedBy && sources}

            {verdictInfo && presentation !== 'suppressed' && (
                <VStack space="xs" testID={hasCheckedBy ? `${testIDPrefix}-own-reading-${item.id}` : undefined}>
                    {hasCheckedBy && (
                        <Text size="xs" className="text-gray-400 font-semibold uppercase">
                            {t('factCheck.ownReadingHeading')}
                        </Text>
                    )}
                    {presentation === 'lead' ? (
                        <Box
                            testID={`${testIDPrefix}-verdict-${item.id}`}
                            className={`self-start rounded-full px-3 py-1 ${TONE_CLASSES[verdictInfo.tone].chip}`}
                        >
                            <Text size="xs" className={`font-semibold ${TONE_CLASSES[verdictInfo.tone].text}`}>
                                {t(verdictInfo.labelKey as any)}
                            </Text>
                        </Box>
                    ) : (
                        // 'secondary' — no chip background, see FactCheckPanel
                        // for the same call.
                        <Text
                            size="xs"
                            testID={`${testIDPrefix}-verdict-secondary-${item.id}`}
                            className={`font-semibold ${TONE_CLASSES[verdictInfo.tone].text}`}
                        >
                            {t(verdictInfo.labelKey as any)}
                        </Text>
                    )}
                </VStack>
            )}

            {!hasCheckedBy && sources}

                    <Text size="xs" className="text-gray-500">
                        {t('factCheck.disclaimer')}
                    </Text>
                </VStack>
            </Pressable>

            {onDelete ? (
                <Pressable
                    onPress={() => onDelete(item.id)}
                    accessibilityRole="button"
                    accessibilityLabel={t('factCheck.dashboard.deleteA11y')}
                    testID={`${testIDPrefix}-delete-${item.id}`}
                    hitSlop={12}
                    className="absolute top-2 right-2 p-1"
                >
                    <MaterialIcons name="delete-outline" size={20} color="#9ca3af" />
                </Pressable>
            ) : null}
        </Box>
    );
};

export default FactCheckCard;
