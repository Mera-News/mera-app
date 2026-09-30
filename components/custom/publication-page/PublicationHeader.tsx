import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import logger from '@/lib/logger';
import { openInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { homepageUrlOf, hostOf, monogramHueOf, monogramOf } from './publication-format';

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
    hostLine: 18,
    detailsLine: 18,
    /** Space between the name, the host and the details line. */
    lineGap: 4,
    linkTarget: 44,
} as const;

const HOST_COLOR = 'rgb(156,163,175)';
const DETAILS_COLOR = 'rgb(156,163,175)';
const SKELETON_FILL = 'rgba(255,255,255,0.08)';

const LINK_FRAME = {
    minHeight: PUBLICATION_HEADER_METRICS.linkTarget,
    marginVertical: -(PUBLICATION_HEADER_METRICS.linkTarget - PUBLICATION_HEADER_METRICS.hostLine) / 2,
    justifyContent: 'center',
    alignSelf: 'flex-start',
} as const;

/** The tile's three inks from one hue: a deep tinted fill, a hairline in the
 *  same hue and a pale letter. Saturation and lightness are fixed, so every
 *  outlet sits at the same visual weight on the dark header whatever its hue. */
export function monogramInks(hue: number): { fill: string; border: string; letter: string } {
    return {
        fill: `hsl(${hue}, 32%, 20%)`,
        border: `hsla(${hue}, 55%, 60%, 0.35)`,
        letter: `hsl(${hue}, 75%, 84%)`,
    };
}

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

    const showDetails = !!details || !!badge;

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
                {host ? (
                    // The glyph is drawn UNDER a childless labelled button: a
                    // glyph inside a labelled pressable still surfaces on iOS
                    // as its own StaticText holding the icon-font character.
                    <View style={LINK_FRAME} testID="publication-website-frame">
                        <HStack
                            space="xs"
                            className="items-center"
                            accessible={false}
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                        >
                            <Text
                                size="sm"
                                numberOfLines={1}
                                style={{ color: HOST_COLOR, flexShrink: 1, lineHeight: PUBLICATION_HEADER_METRICS.hostLine }}
                            >
                                {host}
                            </Text>
                            <MaterialIcons name="open-in-new" size={13} color={HOST_COLOR} />
                        </HStack>
                        <Pressable
                            testID="publication-website"
                            onPress={openWebsite}
                            accessibilityRole="link"
                            accessibilityLabel={t('publicationPage.websiteA11y', { host })}
                            style={StyleSheet.absoluteFill}
                        />
                    </View>
                ) : null}
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
                        space="sm"
                        className="items-center"
                        style={{ minHeight: PUBLICATION_HEADER_METRICS.detailsLine }}
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
                        {details ? (
                            <Text
                                size="xs"
                                numberOfLines={1}
                                style={{ color: DETAILS_COLOR, flexShrink: 1, lineHeight: PUBLICATION_HEADER_METRICS.detailsLine }}
                                testID="publication-data-line"
                            >
                                {details}
                            </Text>
                        ) : null}
                    </HStack>
                ) : null}
            </VStack>
        </View>
    );
};

export default PublicationHeader;
