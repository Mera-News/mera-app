import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { SourceCountryFlag } from '@/components/custom/SourceCountryFlag';
import { SourceFlag } from '@/components/custom/SourceFlag';
import { Text } from '@/components/ui/text';
import { getLocalizedLanguageName } from '@/lib/language-names';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { useTimeTick } from '@/lib/time-tick';
import { getArticleTranslatableStatus, useTranslationBlocked } from '@/lib/translation-service';
import { formatTimeAgo } from '@/lib/utils/time-ago';
import { toTitleCase } from '@/lib/utils/title-case';
import { Pressable } from '@/components/ui/pressable';
import { Tooltip, TooltipContent, TooltipText } from '@/components/ui/tooltip';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

export type ArticleMetaRowVariant = 'card' | 'screen';

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

    const age = formatTimeAgo(t, pubDate, { now, emptyLabel: t('feed.justNow'), absoluteAfterDays: 7 });
    // Named in the reader's own language, not its endonym — "简体中文" tells a
    // reader who doesn't know the script nothing about what they're looking at.
    const language = getLocalizedLanguageName(languageCode, appLanguage) ?? '';
    const publication = toTitleCase(publicationName);

    const translateStatus = getArticleTranslatableStatus(languageCode, appLanguage);

    // The OS translator has given up on the reader's language, so this
    // article — which the device COULD normally translate — is showing the
    // server-side English instead of their language. That is a failure, and
    // the one the reader can act on, so it gets red.
    //
    // Read off the breaker's own reactive subscription, deliberately: this is
    // the same state that made <TranslatableDynamic> fall back, so the icon
    // cannot disagree with the text next to it. A separate flag here would
    // drift the moment one of the two paths changed.
    // Called unconditionally — the status test is applied to its RESULT, not
    // used to decide whether to subscribe.
    const languageBlocked = useTranslationBlocked(appLanguage) !== null;
    const translationFailed = translateStatus === 'translatable' && languageBlocked;
    const [showFailureTip, setShowFailureTip] = useState(false);

    // Pastel yellow, not red: the device can't translate this one, but Google
    // Translate can — that's an alternative route, not a failure. Red is
    // reserved for the case above, where translation was supposed to work.
    const translateColor = translationFailed
        ? '#F87171'
        : translateStatus === 'not-translatable' ? '#FDE68A' : '#86EFAC';
    // M6: the language label only when it tells the reader something. An
    // article already in the reader's language needs no "English" and no
    // translate glyph next to it.
    const sameLanguage = !!languageCode && !!appLanguage &&
        languageCode.split('-')[0].toLowerCase() === appLanguage.split('-')[0].toLowerCase();
    const showLanguageSlot = !!languageCode && (!sameLanguage || translationFailed);
    const showPublicationSlot = !!publication;

    const dot = (
        <Text size="xs" className={secondaryColor} accessibilityElementsHidden importantForAccessibility="no">
            ·
        </Text>
    );

    return (
        // M5: GROUPED LEFT, one reading line: flag, publication, age, then the
        // language. It used to be `justify-between`, which spread four slots
        // edge to edge and read as four unrelated labels.
        //
        // TRUNCATION ORDER, enforced by flex rather than measurement: the time
        // never shrinks (`flexShrink: 0`); the language shrinks a thousand times
        // faster than the publication, so under pressure it collapses to nothing
        // first (its slot clips, dot and glyph included), and only then does
        // the publication truncate with an ellipsis.
        <HStack className="items-center" space="xs" style={{ minWidth: 0 }}>
            {/* 1. Country flag. Tappable on the detail screen to name the country.
                Hidden when `showFlag` is false (compact card shows it in its footer). */}
            {showFlag ? (
                <Box className="flex-shrink-0">
                    {isCard ? (
                        <SourceFlag countryCode={countryCode} size="sm" iconClassName="text-typography-500" />
                    ) : (
                        <SourceCountryFlag countryCode={countryCode} iconClassName="text-gray-400" />
                    )}
                </Box>
            ) : null}

            {/* 2. Publication: truncates second, after the language is gone. */}
            {showPublicationSlot ? (
                <Text
                    size="xs"
                    bold
                    className={secondaryColor}
                    numberOfLines={1}
                    style={{ flexShrink: 1, minWidth: 0 }}
                >
                    {publication}
                </Text>
            ) : null}

            {/* 3. Age (+ optional NEW badge). Never shrinks. Omitted wholesale
                when `showRecency` is false; see the prop's doc. */}
            {showRecency ? (
                <HStack className="items-center flex-shrink-0" space="xs">
                    {showPublicationSlot || showFlag ? dot : null}
                    <Text size="xs" className={ageColor}>
                        {age}
                    </Text>
                    {/* A read card never shows NEW: read wins. */}
                    {isCard && isNew && !read ? (
                        <Box className="px-2 py-0.5 rounded-full" style={{ backgroundColor: '#10B981' }}>
                            <Text size="xs" style={{ color: '#FFFFFF', fontWeight: '600' }}>
                                {t('feed.newBadge')}
                            </Text>
                        </Box>
                    ) : null}
                </HStack>
            ) : null}

            {/* 4. Caller-supplied accessory (the compact card's priority chip). */}
            {centerAccessory ? (
                <Box className="flex-shrink-0">{centerAccessory}</Box>
            ) : null}

            {/* 5. Language: shrinks FIRST (flexShrink 1000) and clips to nothing. */}
            {showLanguageSlot ? (
                <HStack
                    className="items-center"
                    space="xs"
                    style={{ flexShrink: 1000, minWidth: 0, overflow: 'hidden' }}
                    testID="meta-language-slot"
                >
                    {dot}
                    {/* SAME glyph in every state: only the colour changes. The
                        failed state additionally makes it tappable, because it
                        is the only state that has anything to say. */}
                    {translationFailed ? (
                        <Tooltip
                            placement="top"
                            isOpen={showFailureTip}
                            onClose={() => setShowFailureTip(false)}
                            trigger={(triggerProps) => (
                                <Pressable
                                    {...triggerProps}
                                    testID="meta-translate-failed"
                                    hitSlop={8}
                                    onPress={() => setShowFailureTip((v) => !v)}
                                >
                                    <MaterialIcons name="translate" size={12} color={translateColor} />
                                </Pressable>
                            )}
                        >
                            <TooltipContent>
                                <TooltipText>{t('language.translationFailedTooltip')}</TooltipText>
                            </TooltipContent>
                        </Tooltip>
                    ) : (
                        <MaterialIcons name="translate" size={12} color={translateColor} />
                    )}
                    {language ? (
                        <Text size="xs" className={secondaryColor} numberOfLines={1}>
                            {language}
                        </Text>
                    ) : null}
                </HStack>
            ) : null}
        </HStack>
    );
};

export default ArticleMetaRow;
