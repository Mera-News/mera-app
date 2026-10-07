import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import logger from '@/lib/logger';
import { openInAppBrowser } from '@/lib/web-browser-utils';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { homepageUrlOf, hostOf, monogramHueOf, monogramInks, monogramOf } from './publication-format';

/** Every header size is here. The letter and each text line carry an
 *  explicit lineHeight: an inline fontSize on the ui Text without one keeps
 *  the size token's smaller line box and clips the glyph (skill Text trap). */
export const PUBLICATION_HEADER_METRICS = {
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

const HOST_COLOR = 'rgb(156,163,175)';
const DETAILS_COLOR = HOST_COLOR;
const SKELETON_FILL = 'rgba(255,255,255,0.08)';

const LINK_FRAME = {
    minHeight: PUBLICATION_HEADER_METRICS.linkTarget,
    marginVertical: -(PUBLICATION_HEADER_METRICS.linkTarget - PUBLICATION_HEADER_METRICS.detailsLine) / 2,
    justifyContent: 'center',
    alignSelf: 'center',
} as const;


export interface PublicationHeaderBadge {
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
}

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
 */
const PublicationHeader: React.FC<PublicationHeaderProps> = ({
    displayName,
    homepageUrl,
    details,
    badge,
    detailsLoading = false,
}) => {
    const { t } = useTranslation();
    const url = homepageUrlOf(homepageUrl);
    const host = url ? hostOf(url) : null;
    const inks = monogramInks(monogramHueOf(displayName));

    const openWebsite = useCallback(() => {
        if (!url) return;
        openInAppBrowser(url).catch((error) => {
            logger.captureException(error, { tags: { screen: 'PublicationPage', method: 'openWebsite' } });
        });
    }, [url]);

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
                    className="text-white font-semibold"
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
                        <View style={{ height: 10, width: '62%', borderRadius: 5, backgroundColor: SKELETON_FILL }} />
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
                            <View style={LINK_FRAME} testID="publication-website-frame">
                                <Text
                                    size="xs"
                                    numberOfLines={1}
                                    accessible={false}
                                    accessibilityElementsHidden
                                    importantForAccessibility="no-hide-descendants"
                                    style={{ color: HOST_COLOR, lineHeight: PUBLICATION_HEADER_METRICS.detailsLine }}
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
                                style={{ color: DETAILS_COLOR, flexShrink: 1, lineHeight: PUBLICATION_HEADER_METRICS.detailsLine }}
                                testID="publication-data-line"
                            >
                                {host ? `· ${details}` : details}
                            </Text>
                        ) : null}
                    </HStack>
                ) : null}
            </VStack>
        </View>
    );
};

export default PublicationHeader;
