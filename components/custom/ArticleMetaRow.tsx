import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { SourceCountryFlag } from '@/components/custom/SourceCountryFlag';
import { SourceFlag } from '@/components/custom/SourceFlag';
import { Text } from '@/components/ui/text';
import { getLocalizedLanguageName } from '@/lib/language-names';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { useTimeTick } from '@/lib/time-tick';
import { formatTimeAgo } from '@/lib/utils/time-ago';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

export type ArticleMetaRowVariant = 'card' | 'screen';

/** The language label's own cap ("Portuguese (Brazil)" fits). */
const LANGUAGE_MAX_WIDTH = 120;
/** The centred publication never takes more than this share of the row. */
const PUBLICATION_MAX_SHARE = 0.58;
/** Breathing room between the centred publication and each side. */
const SIDE_GAP = 8;

interface ArticleMetaRowProps {
    pubDate?: string | null;
    languageCode?: string | null;
    publicationName?: string | null;
    countryCode?: string | null;
    variant: ArticleMetaRowVariant;
    isNew?: boolean;
    /** Marks the article as already-read. Draws NO indicator of its own — the
     *  eye glyph was deliberately removed — but still SUPPRESSES the NEW badge,
     *  since a story you have already read is not new to you. Default false. */
    read?: boolean;
    /** Whether to render the trailing country flag. Default true. The compact
     *  card sets this false and shows the flag in its footer instead. */
    showFlag?: boolean;
    /**
     * Whether to render the leading recency slot. Default true.
     *
     * This covers the WHOLE slot — the clock glyph, the age label, AND the
     * green NEW badge, which shares it. That grouping is the point rather than
     * an accident of layout: both answer "has something arrived?", and the Feed
     * screen sets this false precisely to stop asking. Hiding only the text
     * would leave an orphan clock glyph next to a NEW pill.
     */
    showRecency?: boolean;
    /**
     * A slot rendered between the recency and language slots.
     *
     * The row is already `justify-between`, so a third populated slot lands in
     * the middle of the free space with no new layout machinery — the same
     * shape the full-size card gets from its publication slot. The compact card
     * puts its priority chip here. Absent by default, so every other caller is
     * unchanged.
     */
    centerAccessory?: React.ReactNode;
}

export const ArticleMetaRow: React.FC<ArticleMetaRowProps> = ({
    pubDate,
    languageCode,
    publicationName,
    countryCode,
    variant,
    isNew = false,
    read = false,
    showFlag = true,
    showRecency = true,
    centerAccessory,
}) => {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();
    // The shared 60s clock (lib/time-tick.ts). THIS is what keeps the age
    // honest: `formatTimeAgo` is pure, so the label is only ever as fresh as
    // the render that produced it — and every card above this row is
    // `React.memo`'d over a view-model that never changes, so without a source
    // of its own this row would render once and freeze ("37m ago" still
    // reading "37m ago" half an hour later).
    //
    // Subscribing HERE, in the leaf, is deliberate on two counts: a
    // component's own store subscription re-renders it whatever its parents'
    // memo says, and the re-render stays inside this row — it cannot reach the
    // Dashboard's throttled section-order snapshot or any parent's row
    // derivation, which must NOT move on a clock tick.
    const now = useTimeTick();

    const isCard = variant === 'card';
    const ageColor = isCard ? 'text-typography-600' : 'text-gray-400';
    const secondaryColor = isCard ? 'text-typography-500' : 'text-gray-400';
    const iconColor = isCard ? '#6B7280' : '#9CA3AF';

    const age = formatTimeAgo(t, pubDate, { now, emptyLabel: t('feed.justNow'), absoluteAfterDays: 7 });
    // Named in the reader's own language, not its endonym — "简体中文" tells a
    // reader who doesn't know the script nothing about what they're looking at.
    const language = getLocalizedLanguageName(languageCode, appLanguage) ?? '';
    // Shown EXACTLY as stored, card and detail (owner decision): title-casing
    // turned "Instituto Nacional de Ciberseguridad (INCIBE)" into
    // "... De ... (Incibe)".
    const publication = (publicationName ?? '').trim();

    // No translate glyph on this row in ANY state, compact rows included
    // (owner decision): a failed translation is explained by the detail
    // screen's translation notice, so the row carries flag + language only.

    // Measured widths for the centred layout's publication cap.
    const [rowWidth, setRowWidth] = useState(0);
    const [leftWidth, setLeftWidth] = useState(0);
    const [rightWidth, setRightWidth] = useState(0);
    const showLanguageSlot = !!languageCode;
    const showPublicationSlot = !!publication;

    // ── The segments, shared by both layouts ────────────────────────────────
    const ageEl =
        showRecency ? (
                <HStack className="items-center" space="xs" style={{ flexShrink: 0 }} testID="meta-age-slot">
                    <MaterialIcons name="schedule" size={14} color={iconColor} />
                    <Text size="sm" className={ageColor}>
                        {age}
                    </Text>
                    {/* No read indicator is drawn. `read` still SUPPRESSES the NEW
                        badge below — the seen mechanism is intact end to end (card
                        state, the "All caught up" partition, scoring); it is only
                        the eye glyph that is deliberately not shown. */}
                    {/* A read card never shows NEW — read wins. */}
                    {isCard && isNew && !read ? (
                        <Box className="px-2 py-0.5 rounded-full" style={{ backgroundColor: '#10B981' }}>
                            <Text size="xs" style={{ color: '#FFFFFF', fontWeight: '600' }}>
                                {t('feed.newBadge')}
                            </Text>
                        </Box>
                    ) : null}
                </HStack>
            ) : null;
    const languageEl =
        showLanguageSlot ? (
                <HStack className="items-center" space="xs" style={{ flexShrink: 0 }} testID="meta-language-slot">
                    {language ? (
                        <Text
                            size="xs"
                            className={secondaryColor}
                            numberOfLines={1}
                            ellipsizeMode="tail"
                            // A long language name trims too, instead of
                            // squeezing the publication to nothing.
                            style={{ maxWidth: LANGUAGE_MAX_WIDTH }}
                        >
                            {language}
                        </Text>
                    ) : null}
                </HStack>
            ) : null;
    const flagEl =
        showFlag ? (
                <Box style={{ flexShrink: 0 }} testID="meta-flag">
                    {isCard ? (
                        <SourceFlag countryCode={countryCode} size="sm" iconClassName="text-typography-500" />
                    ) : (
                        <SourceCountryFlag countryCode={countryCode} iconClassName="text-gray-400" />
                    )}
                </Box>
            ) : null;

    // COMPACT rows (no publication in this row; the publisher sits in their
    // footer and the middle slot is the priority chip): time, chip, then flag
    // and language together at the right, spread across the width.
    if (!showPublicationSlot) {
        return (
            <HStack className="items-center justify-between" space="sm">
                {ageEl}
                {centerAccessory ? <Box style={{ flexShrink: 0 }}>{centerAccessory}</Box> : null}
                {/* The flag sits immediately left of the language (owner). */}
                <HStack className="items-center" space="xs" style={{ flexShrink: 0 }} testID="meta-flag-language">
                    {flagEl}
                    {languageEl}
                </HStack>
            </HStack>
        );
    }

    // CARD and DETAIL rows with a publication (owner spec, ONE order for both):
    //
    //   |🕒 22h      📰 National Cyber Security Cen…      🇳🇱 Dutch|
    //   |            📰 NOS                               🇳🇱 Dutch|   (Feed: no time)
    //
    // Left: clock + age (+ NEW), or nothing on the Feed, which hides it.
    // Centre: the publication. Right: flag, then the language name, with NO
    // translate glyph in any state (owner decision: a failed translation is
    // explained by the detail screen's translation notice, not by this row).
    //
    // The two sides are equal `flex: 1` columns (start- and end-aligned), so
    // the middle stays truly centred however different the sides are (an empty
    // side included), and grows symmetrically as the name gets longer. Its
    // width is capped at min(58% of the row, row − 2 × the wider side),
    // measured with onLayout, so it never overlaps a side; past the cap it is
    // trimmed on the right. The sides never shrink.
    const sideWidth = Math.max(leftWidth, rightWidth);
    const publicationCap =
        rowWidth > 0
            ? Math.max(0, Math.min(rowWidth * PUBLICATION_MAX_SHARE, rowWidth - 2 * sideWidth - 2 * SIDE_GAP))
            : undefined;
    return (
        <HStack
            className="items-center"
            testID="meta-row"
            onLayout={(e) => setRowWidth(Math.round(e.nativeEvent.layout.width))}
        >
            <HStack className="items-center" style={{ flex: 1, justifyContent: 'flex-start' }} testID="meta-left">
                {showRecency ? (
                    <HStack
                        className="items-center"
                        space="xs"
                        style={{ flexShrink: 0 }}
                        testID="meta-age-slot"
                        onLayout={(e) => setLeftWidth(Math.round(e.nativeEvent.layout.width))}
                    >
                        <MaterialIcons name="schedule" size={14} color={iconColor} />
                        <Text size="sm" className={ageColor}>
                            {age}
                        </Text>
                        {isCard && isNew && !read ? (
                            <Box className="px-2 py-0.5 rounded-full" style={{ backgroundColor: '#10B981' }}>
                                <Text size="xs" style={{ color: '#FFFFFF', fontWeight: '600' }}>
                                    {t('feed.newBadge')}
                                </Text>
                            </Box>
                        ) : null}
                    </HStack>
                ) : null}
            </HStack>

            <HStack
                className="items-center justify-center"
                space="xs"
                style={{ maxWidth: publicationCap ?? `${PUBLICATION_MAX_SHARE * 100}%`, minWidth: 0, flexShrink: 1 }}
                testID="meta-publication-slot"
            >
                <MaterialIcons name="newspaper" size={12} color={iconColor} />
                <Text
                    size="xs"
                    bold
                    className={secondaryColor}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                    style={{ flexShrink: 1, textAlign: 'center' }}
                >
                    {publication}
                </Text>
            </HStack>

            <HStack className="items-center" style={{ flex: 1, justifyContent: 'flex-end' }} testID="meta-right">
                <HStack
                    className="items-center"
                    space="xs"
                    style={{ flexShrink: 0 }}
                    onLayout={(e) => setRightWidth(Math.round(e.nativeEvent.layout.width))}
                >
                    {flagEl}
                    {showLanguageSlot && language ? (
                        <HStack className="items-center" space="xs" style={{ flexShrink: 0 }} testID="meta-language-slot">
                            <Text
                                size="xs"
                                className={secondaryColor}
                                numberOfLines={1}
                                ellipsizeMode="tail"
                                style={{ maxWidth: LANGUAGE_MAX_WIDTH }}
                            >
                                {language}
                            </Text>
                        </HStack>
                    ) : null}
                </HStack>
            </HStack>
        </HStack>
    );
};

export default ArticleMetaRow;
