import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import logger from '@/lib/logger';
import { secureUrlOrNull } from '@/lib/secure-url';
import { openInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { hostOf, monogramOf } from './publication-format';

/** The monogram tile. Every size is here, and the letter carries an explicit
 *  lineHeight: an inline fontSize on the ui Text without one keeps the size
 *  token's smaller line box and clips the glyph (see the skill's Text trap). */
export const PUBLICATION_HEADER_METRICS = {
    tile: 48,
    tileRadius: 12,
    letterSize: 22,
    letterLineHeight: 30,
    hostLine: 18,
    linkTarget: 44,
} as const;

const TILE_FILL = 'rgba(255,255,255,0.10)';
const HOST_COLOR = 'rgb(156,163,175)';

const LINK_FRAME = {
    minHeight: PUBLICATION_HEADER_METRICS.linkTarget,
    marginVertical: -(PUBLICATION_HEADER_METRICS.linkTarget - PUBLICATION_HEADER_METRICS.hostLine) / 2,
    justifyContent: 'center',
    alignSelf: 'flex-start',
} as const;

interface PublicationHeaderProps {
    /** The name as displayed (display name when the app language has one). */
    readonly displayName: string;
    /** The publication's homepage; no link without one. */
    readonly homepageUrl?: string | null;
}

/**
 * Monogram tile, name, website host. The DrillDownHeader's title content.
 *
 * Logo: there is NONE stored anywhere, so the tile is a monogram. The device
 * never fetches a favicon from a third party, because that request would tell
 * that third party which sources this reader looks at.
 *
 * The host opens the in-app browser and records NO publication visit: the
 * Visited tab is "articles you opened at the publisher", and a homepage is
 * not an article.
 */
const PublicationHeader: React.FC<PublicationHeaderProps> = ({ displayName, homepageUrl }) => {
    const { t } = useTranslation();
    const url = secureUrlOrNull(homepageUrl);
    const host = url ? hostOf(url) : null;

    const openWebsite = useCallback(() => {
        if (!url) return;
        openInAppBrowser(url).catch((error) => {
            logger.captureException(error, { tags: { screen: 'PublicationPage', method: 'openWebsite' } });
        });
    }, [url]);

    return (
        <HStack space="md" className="items-center flex-1" testID="publication-header">
            <View
                testID="publication-monogram"
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{
                    width: PUBLICATION_HEADER_METRICS.tile,
                    height: PUBLICATION_HEADER_METRICS.tile,
                    borderRadius: PUBLICATION_HEADER_METRICS.tileRadius,
                    backgroundColor: TILE_FILL,
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <Text
                    style={{
                        color: '#FFFFFF',
                        fontSize: PUBLICATION_HEADER_METRICS.letterSize,
                        lineHeight: PUBLICATION_HEADER_METRICS.letterLineHeight,
                        fontWeight: '700',
                    }}
                >
                    {monogramOf(displayName)}
                </Text>
            </View>
            <VStack className="flex-1">
                <Text
                    size="lg"
                    className="text-white font-semibold"
                    numberOfLines={2}
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
                            <Text size="sm" numberOfLines={1} style={{ color: HOST_COLOR, flexShrink: 1 }}>
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
            </VStack>
        </HStack>
    );
};

export default PublicationHeader;
