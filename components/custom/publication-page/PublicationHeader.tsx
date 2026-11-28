import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { Appear } from '@/components/ui/appear';
import { maxFontSizeMultiplierFor } from '@/lib/algorithms/policy';
import { TYPE_SCALE } from '@/lib/algorithms/scale';
import { WEBSITE_URL } from '@/lib/config/branding';
import logger from '@/lib/logger';
import { inlineSign } from '@/lib/motion';
import { useColors, useThemeMode } from '@/lib/theme/tokens';
import { scaledTypeStyle, useTextScale } from '@/lib/typography/TextScaleContext';
import { openInAppBrowser, withAppLanguage } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import {
    homepageUrlOf,
    hostOf,
    monogramHueOf,
    monogramInks,
    monogramOf,
    readingScoreInk,
} from './publication-format';

/** Every header size is here. The letter and each text line carry an
 *  explicit lineHeight: an inline fontSize on the ui Text without one keeps
 *  the size token's smaller line box and clips the glyph (skill Text trap). */
const PUBLICATION_HEADER_METRICS = {
    tile: 56,
    tileRadius: 16,
    letterSize: 26,
    letterLineHeight: 34,
    nameSize: 22,
    nameLine: 28,
    detailsLine: 18,
    /** Space between the name, the host and the details line. */
    lineGap: 4,
    linkTarget: 44,
} as const;


const LINK_FRAME = {
    minHeight: PUBLICATION_HEADER_METRICS.linkTarget,
    marginTop: -(PUBLICATION_HEADER_METRICS.linkTarget - PUBLICATION_HEADER_METRICS.detailsLine) / 2,
    marginBottom: -(PUBLICATION_HEADER_METRICS.linkTarget - PUBLICATION_HEADER_METRICS.detailsLine) / 2,
    justifyContent: 'center',
    alignSelf: 'center',
} as const;


/** With the score line below, the link's target gives 5 (not 13) to the line
 *  under it: 13 + 18 + 5 = 36. */
const LINK_FRAME_WITH_SCORE = {
    ...LINK_FRAME,
    marginTop: -13,
    marginBottom: -5,
    minHeight: 36,
} as const;

interface PublicationHeaderBadge {
    readonly label: string;
    readonly color: string;
}

interface PublicationHeaderProps {
    /** The name as displayed (display name when the app language has one). */
    readonly displayName: string;
    /** The publication's homepage; no link without one. */
    readonly homepageUrl?: string | null;
    /** "India · English · General news". Omitted when there is nothing to say. */
    readonly details?: string | null;
    /** The official-agency badge, drawn at the start of the details line. */
    readonly badge?: PublicationHeaderBadge | null;
    /** The profile is loading: hold the details line's height with a bar, so
     *  the bar and everything under it do not move when the details land. */
    readonly detailsLoading?: boolean;
    /** The phone reading score (0..100), or null when the publication has none. */
    readonly readingScore?: number | null;
    /** The 24-hex news-publisher id the report URL uses. */
    readonly reportPublisherId?: string | null;
    /** Reserve the score line's height, so the controls below do not move. */
    readonly scoreReserved?: boolean;
}

const ARC = { size: 14, r: 6, stroke: 2 } as const;

/** Decorative: a ring with the score drawn clockwise from 12 o'clock. Never
 *  mirrored in right-to-left. Colour comes from the helper, never a class. */
const ScoreArc: React.FC<{ readonly score: number }> = ({ score }) => {
    const colors = useColors();
    const mode = useThemeMode();
    const c = 2 * Math.PI * ARC.r;
    const mid = ARC.size / 2;
    return (
        <Svg width={ARC.size} height={ARC.size} testID="publication-score-arc">
            <Circle cx={mid} cy={mid} r={ARC.r} strokeWidth={ARC.stroke} stroke={colors.trackFill} fill="none" />
            <Circle
                cx={mid}
                cy={mid}
                r={ARC.r}
                strokeWidth={ARC.stroke}
                stroke={readingScoreInk(score, mode)}
                fill="none"
                strokeDasharray={[(c * score) / 100, c]}
                strokeLinecap="round"
                rotation={-90}
                origin={`${mid}, ${mid}`}
            />
        </Svg>
    );
};

/**
 * The page's identity block, at the top of the page body (NOT in the top bar:
 * three lines plus a tile overflowed the bar, and the host link's 44pt frame,
 * given back by negative margins, made the bar measure shorter than it drew).
 * Monogram tile, name, website host, and what we know about the outlet
 * (country, languages, categories, official badge): everything that says WHO
 * this is sits together, and the controls under it say what the reader can DO.
 *
 * Logo: there is NONE stored anywhere, so the tile is a monogram, tinted with
 * a hue derived from the name. The device never fetches a favicon from a third
 * party, because that request would tell it which sources this reader views.
 *
 * The host opens the in-app browser and records NO publication visit: the
 * Visited tab is "articles you opened at the publisher", and a homepage is
 * not an article.
 *
 * Under the details line sits the phone reading score line: a small arc, the
 * score and a chevron, which opens the publication's report on mera.news. Its
 * height is reserved (also while the profile loads or the publication has no
 * score) so the buttons below do not move when the score lands. It is not
 * reserved once the server is latched as lacking the field (`scoreReserved`).
 */
const PublicationHeader: React.FC<PublicationHeaderProps> = ({
    displayName,
    homepageUrl,
    details,
    badge,
    detailsLoading = false,
    readingScore = null,
    reportPublisherId = null,
    scoreReserved = false,
}) => {
    const { t } = useTranslation();
    const colors = useColors();
    const url = homepageUrlOf(homepageUrl);
    const host = url ? hostOf(url) : null;
    const inks = monogramInks(monogramHueOf(displayName));

    const openWebsite = useCallback(() => {
        if (!url) return;
        openInAppBrowser(url).catch((error) => {
            logger.captureException(error, { tags: { screen: 'PublicationPage', method: 'openWebsite' } });
        });
    }, [url]);

    // The score text's rendered line: the in-app scale sets lineHeight, and React Native then multiplies
    // it by the OS font scale, capped as the ui Text caps it. Reserve and the arc box use the same line,
    // or at a large OS size the line outgrows the reserve (the buttons move) and the arc sits high.
    const userScale = useTextScale();
    const { fontScale } = useWindowDimensions();
    const lineHeight =
        (scaledTypeStyle('xs', userScale)?.lineHeight ?? TYPE_SCALE.xs.lineHeight) *
        Math.min(fontScale || 1, maxFontSizeMultiplierFor('content', userScale));
    const openReport = useCallback(() => {
        if (!reportPublisherId) return;
        openInAppBrowser(withAppLanguage(`${WEBSITE_URL}/publications/${reportPublisherId}`)).catch((error) => {
            logger.captureException(error, { tags: { screen: 'PublicationPage', method: 'openReport' } });
        });
    }, [reportPublisherId]);

    const showDetails = !!details || !!badge || !!host;

    return (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 14 }} testID="publication-header">
            <View
                testID="publication-monogram"
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{
                    width: PUBLICATION_HEADER_METRICS.tile,
                    height: PUBLICATION_HEADER_METRICS.tile,
                    borderRadius: PUBLICATION_HEADER_METRICS.tileRadius,
                    backgroundColor: inks.fill,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: inks.border,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginTop: 2,
                }}
            >
                <Text
                    style={{
                        color: inks.letter,
                        fontSize: PUBLICATION_HEADER_METRICS.letterSize,
                        lineHeight: PUBLICATION_HEADER_METRICS.letterLineHeight,
                        fontWeight: '700',
                    }}
                >
                    {monogramOf(displayName)}
                </Text>
            </View>
            <VStack className="flex-1" style={{ gap: PUBLICATION_HEADER_METRICS.lineGap }}>
                <Text
                    className="text-ink font-semibold"
                    style={{ fontSize: PUBLICATION_HEADER_METRICS.nameSize, lineHeight: PUBLICATION_HEADER_METRICS.nameLine }}
                    numberOfLines={3}
                    accessibilityRole="header"
                    testID="publication-name"
                >
                    {displayName}
                </Text>
                {detailsLoading ? (
                    <View
                        testID="publication-profile-skeleton"
                        accessible={false}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                        style={{ minHeight: PUBLICATION_HEADER_METRICS.detailsLine, justifyContent: 'center' }}
                    >
                        <View style={{ height: 10, width: '62%', borderRadius: 5, backgroundColor: colors.trackFill }} />
                    </View>
                ) : showDetails ? (
                    <HStack
                        className="items-center"
                        style={{ minHeight: PUBLICATION_HEADER_METRICS.detailsLine, gap: 4 }}
                        testID="publication-details"
                    >
                        {badge ? (
                            <View
                                testID="publication-official-badge"
                                style={{
                                    borderRadius: 5,
                                    borderWidth: 1,
                                    borderColor: `${badge.color}80`,
                                    paddingHorizontal: 5,
                                }}
                            >
                                <Text size="2xs" style={{ color: badge.color, letterSpacing: 0.3, lineHeight: 15 }}>
                                    {badge.label}
                                </Text>
                            </View>
                        ) : null}
                        {host ? (
                            // FinalLibrary #14: the host leads the data line. The
                            // visual sits UNDER a childless labelled link (the
                            // glyph-leak pattern); its 44pt frame is given back by
                            // negative margins so the line keeps its height.
                            <View style={scoreReserved ? LINK_FRAME_WITH_SCORE : LINK_FRAME} testID="publication-website-frame">
                                <Text
                                    size="xs"
                                    numberOfLines={1}
                                    accessible={false}
                                    accessibilityElementsHidden
                                    importantForAccessibility="no-hide-descendants"
                                    style={{ color: colors.ink3, lineHeight: PUBLICATION_HEADER_METRICS.detailsLine }}
                                >
                                    {host}
                                </Text>
                                <Pressable
                                    testID="publication-website"
                                    onPress={openWebsite}
                                    accessibilityRole="link"
                                    accessibilityLabel={t('publicationPage.websiteA11y', { host })}
                                    style={StyleSheet.absoluteFill}
                                />
                            </View>
                        ) : null}
                        {details ? (
                            <Text
                                size="xs"
                                numberOfLines={1}
                                style={{ color: colors.ink3, flexShrink: 1, lineHeight: PUBLICATION_HEADER_METRICS.detailsLine }}
                                testID="publication-data-line"
                            >
                                {host ? `· ${details}` : details}
                            </Text>
                        ) : null}
                    </HStack>
                ) : null}
                {scoreReserved ? (
                    <View testID="publication-score-slot" style={{ marginTop: 6, minHeight: lineHeight }}>
                        {readingScore != null && reportPublisherId ? (
                            <Appear rise={0}>
                                <View
                                    testID="publication-score-frame"
                                    style={{ marginTop: -5, paddingTop: 5, marginBottom: -21, paddingBottom: 21 }}
                                >
                                    <View
                                        accessible={false}
                                        accessibilityElementsHidden
                                        importantForAccessibility="no-hide-descendants"
                                        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}
                                    >
                                        <View style={{ height: lineHeight, justifyContent: 'center' }}>
                                            <ScoreArc score={readingScore} />
                                        </View>
                                        <Text size="xs" numberOfLines={2} style={{ color: colors.ink2, flexShrink: 1 }}>
                                            {t('publicationPage.readingScore', { score: readingScore })}
                                        </Text>
                                        <View style={{ height: lineHeight, justifyContent: 'center' }}>
                                            <MaterialIcons
                                                name="chevron-right"
                                                size={14}
                                                color={colors.ink3}
                                                style={{ transform: [{ scaleX: inlineSign() }] }}
                                            />
                                        </View>
                                    </View>
                                    <Pressable
                                        testID="publication-reading-score"
                                        onPress={openReport}
                                        accessibilityRole="link"
                                        accessibilityLabel={t('publicationPage.readingScoreA11y', { score: readingScore })}
                                        accessibilityHint={t('publicationPage.readingScoreHint')}
                                        style={StyleSheet.absoluteFill}
                                    />
                                </View>
                            </Appear>
                        ) : null}
                    </View>
                ) : null}
            </VStack>
        </View>
    );
};

export default PublicationHeader;
