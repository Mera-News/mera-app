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
import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import React from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

export type ArticleMetaRowVariant = 'card' | 'screen';

/** The language label's own cap ("Portuguese (Brazil)" fits). */
const LANGUAGE_MAX_WIDTH = 120;
/** Breathing room between the centred time and each side column. */
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

    const showLanguageSlot = !!languageCode;
    const showPublicationSlot = !!publication;

    // ── The segments, shared by both layouts ────────────────────────────────
    const ageEl =
        showRecency ? (
                <HStack className="items-center" space="xs" style={{ flexShrink: 0 }} testID="meta-age-slot">
                    <MaterialIcons name="schedule" size={14} color={iconColor} {...DECORATIVE_ICON_A11Y} />
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

    // CARD and DETAIL rows with a publication (owner spec):
    //
    //   |📰 De Telegraaf        🕒 22h        🇳🇱 Dutch|
    //
    // Publication LEFT (from the left edge up to the centre column, trimmed on
    // the right with "…"), time CENTRED (never trimmed), flag + language RIGHT
    // (never trimmed; no translate glyph in any state, owner decision). The two
    // side columns are equal `flex: 1`, so the time stays truly centred however
    // long either side is. Without a time (Feed cards) see below.
    const flagAndLanguage = (
        <HStack className="items-center" space="xs" style={{ flexShrink: 0 }}>
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
    );

    // No time (Feed cards, owner Q5): nothing to centre, so the publication
    // takes all the width up to flag + language and trims on the right.
    //
    //   |📰 De Telegraaf                               🇳🇱 Dutch|
    if (!showRecency) {
        return (
            <HStack className="items-center" space="sm" testID="meta-row">
                <HStack
                    className="items-center"
                    space="xs"
                    style={{ flex: 1, minWidth: 0 }}
                    testID="meta-publication-slot"
                >
                    <MaterialIcons name="newspaper" size={12} color={iconColor} {...DECORATIVE_ICON_A11Y} />
                    <Text
                        size="xs"
                        bold
                        className={secondaryColor}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                        style={{ flexShrink: 1, textAlign: 'left' }}
                    >
                        {publication}
                    </Text>
                </HStack>
                {flagAndLanguage}
            </HStack>
        );
    }

    return (
        <HStack className="items-center" testID="meta-row">
            <HStack className="items-center" style={{ flex: 1, minWidth: 0 }} testID="meta-left">
                <HStack
                    className="items-center"
                    space="xs"
                    style={{ flexShrink: 1, minWidth: 0 }}
                    testID="meta-publication-slot"
                >
                    <MaterialIcons name="newspaper" size={12} color={iconColor} {...DECORATIVE_ICON_A11Y} />
                    <Text
                        size="xs"
                        bold
                        className={secondaryColor}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                        style={{ flexShrink: 1 }}
                    >
                        {publication}
                    </Text>
                </HStack>
            </HStack>

            <View style={{ flexShrink: 0, marginHorizontal: SIDE_GAP }}>{ageEl}</View>

            <HStack className="items-center" style={{ flex: 1, justifyContent: 'flex-end' }} testID="meta-right">
                {flagAndLanguage}
            </HStack>
        </HStack>
    );
};

export default ArticleMetaRow;
