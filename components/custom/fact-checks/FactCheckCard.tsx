import { Box } from '@/components/ui/box';
import { SearchCheck } from 'lucide-react-native';
import FactCheckBadge from '@/components/custom/fact-checks/FactCheckBadge';
import { GLASS_EDGE, GlassPlate } from '@/components/custom/GlassSurface';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import type { CheckedByStatus, FactCheckedByEntry } from '@/lib/fact-check/fact-check-types';
import { describeCheckedBy } from '@/lib/fact-check/fact-check-state';
import type { StoredFactCheck } from '@/lib/database/services/fact-check-record-service';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

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
 * The card's job is to answer "who checked this story, and what did they
 * say" — the badge carries the lead organisation's own rating, and every
 * OTHER gated organisation's NAME is listed below it in plain text, so the
 * data stays reachable even though this surface has no expandable body.
 * Ratings and links for the non-lead organisations live one tap away, on the
 * article screen this row opens.
 *
 * A row whose check has not finished yet renders as "still searching" rather
 * than being hidden — the user asked for it, and a request that vanishes from
 * every surface until it completes is indistinguishable from one that was
 * dropped.
 *
 * EXTERNALS ARE THE AUTHORITY (fc-relevance wave). The badge is
 * externals-only in every state — see `FactCheckBadge`'s file header — so
 * this card never derives or displays a verdict of Mera's own.
 */
const FactCheckCard: React.FC<FactCheckCardProps> = ({
    item,
    onPress,
    onDelete,
    testIDPrefix = 'fact-check-card',
}) => {
    const { t } = useTranslation();

    const checkedBy = (item.payload as { checkedBy?: FactCheckedByEntry[] } | null)?.checkedBy;
    const checkedByStatus = (item.payload as { checkedByStatus?: CheckedByStatus } | null)?.checkedByStatus;
    // Unique names only, comma-joined, in first-appearance order. The same
    // organisation can legitimately appear more than once in `checkedBy` (one
    // entry per claim it ruled on) — this line exists purely so every gated
    // organisation stays reachable by name on a surface with no expandable
    // body, not to enumerate individual claims.
    const organisationNames = Array.from(
        new Set(describeCheckedBy(checkedBy).map((entry) => entry.organisation.trim())),
    );

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
                // UNPADDED and clipping, because `GlassPlate` is an absolute
                // fill and Yoga resolves its insets against the CONTENT box —
                // padding here would leave an unglassed frame. The padding
                // moves to the inner VStack. The platform branch is the
                // primitive's: real Liquid Glass where expo reports it
                // available, a flat fill at the same tint everywhere else.
                className={`rounded-lg overflow-hidden ${GLASS_EDGE}`}
            >
                <GlassPlate />
                <VStack space="sm" className="p-3">
            <HStack space="xs" className="items-start pr-8">
                    <SearchCheck
                        size={16}
                        strokeWidth={2}
                        color={ACCENT}
                        style={{ marginTop: 2 }}
                    />
                    {item.articleTitle?.trim() ? (
                        <TranslatableDynamic
                            text={item.articleTitle.trim()}
                            size="sm"
                            className="text-gray-100 font-semibold flex-1 ml-1"
                            numberOfLines={3}
                        />
                    ) : (
                        <Text size="sm" className="text-gray-100 font-semibold flex-1 ml-1" numberOfLines={3}>
                            {t('factCheck.dashboard.untitled')}
                        </Text>
                    )}
            </HStack>

            {/* The claim this ROW is about. An article can carry several rows
                post-v52 (one per claim the user picked) — without this line
                two rows for the same headline are indistinguishable except by
                their verdict. Absent on a legacy (pre-v52) whole-article row. */}
            {item.claim ? (
                <TranslatableDynamic
                    text={item.claim}
                    size="xs"
                    className="text-gray-400"
                    italic
                    numberOfLines={2}
                />
            ) : null}

            {/* One status line, and which one is a correctness question — see
                FactCheckBadge. Shared with the article panel's collapsed
                header so the two surfaces cannot drift. */}
            <FactCheckBadge
                status={item.status}
                checkedBy={checkedBy}
                checkedByStatus={checkedByStatus}
                testIDPrefix={testIDPrefix}
                testIDSuffix={item.id}
            />

            {organisationNames.length > 0 && (
                <Text
                    size="xs"
                    className="text-gray-500"
                    numberOfLines={2}
                    testID={`${testIDPrefix}-org-names-${item.id}`}
                >
                    {organisationNames.join(', ')}
                </Text>
            )}
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
