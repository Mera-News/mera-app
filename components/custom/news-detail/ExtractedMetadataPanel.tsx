import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useShowExtractedMetadata } from '@/lib/stores/mera-protocol-store';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

export interface ExtractedMetadataGeoTag {
    city?: string | null;
    region?: string | null;
    countryCode?: string | null;
}

interface ExtractedMetadataPanelProps {
    /** Controlled `event_type` token (e.g. `science_tech`) — humanized inline
     *  rather than through a label table, so a new server value never needs a
     *  new locale key. */
    eventType?: string | null;
    entities?: string[] | null;
    /** Only ever populated from the live `articleById` query (`NewsArticle`) —
     *  a suggestion-sourced row never carries this field, see
     *  `ArticleSuggestionContainer`. */
    geoTags?: ExtractedMetadataGeoTag[] | null;
}

/** `science_tech` → `Science Tech`. No lookup table on purpose — a new
 *  controlled value from the server must not require a new locale key across
 *  20 languages just to render. */
const humanizeToken = (raw: string): string =>
    raw
        .split('_')
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

const formatPlace = (tag: ExtractedMetadataGeoTag): string | null => {
    const parts = [tag.city, tag.region, tag.countryCode].filter(
        (p): p is string => !!p && p.trim().length > 0,
    );
    return parts.length > 0 ? parts.join(', ') : null;
};

/**
 * Transparency panel for the server's machine-extracted tags on the open
 * story — places, named entities, event type. Gated behind the Mera Protocol
 * "show extracted metadata" toggle (default OFF) via `useShowExtractedMetadata`.
 *
 * Renders `null` whenever the toggle is off OR every field is empty — absence
 * is the normal case here (measured coverage on real data: event_type ~100%,
 * entities ~77%, geo_tags ~71%), never an error state, so there is no empty
 * placeholder to fall back to.
 *
 * This is a machine read of the story, not a verified fact — hand-audited
 * accuracy is well under 100% (event_type ~94%, geo_tags ~81%, entities
 * ~69%). The caption below the data exists so provenance is never implicit.
 */
const ExtractedMetadataPanel: React.FC<ExtractedMetadataPanelProps> = ({
    eventType,
    entities,
    geoTags,
}) => {
    const { t } = useTranslation();
    const enabled = useShowExtractedMetadata();

    if (!enabled) return null;

    const places = (geoTags ?? [])
        .map(formatPlace)
        .filter((p): p is string => !!p);
    const entityList = (entities ?? []).filter(
        (e): e is string => typeof e === 'string' && e.trim().length > 0,
    );
    const eventTypeLabel = eventType ? humanizeToken(eventType) : null;

    if (!eventTypeLabel && places.length === 0 && entityList.length === 0) return null;

    return (
        <Box
            className="rounded-lg p-3 border border-gray-800 bg-background-50"
            testID="article-detail-extracted-metadata"
        >
            <HStack space="sm" className="items-center mb-2">
                <MaterialIcons name="sell" size={16} color="#9ca3af" />
                <Text className="text-typography-400 text-xs font-semibold uppercase">
                    {t('meraProtocol.extractedMetadataPanelHeading')}
                </Text>
            </HStack>
            <VStack space="xs">
                {eventTypeLabel ? (
                    <HStack space="xs">
                        <Text size="xs" className="text-typography-500">
                            {t('meraProtocol.extractedMetadataEventTypeLabel')}
                        </Text>
                        <Text size="xs" className="text-typography-300 flex-1">
                            {eventTypeLabel}
                        </Text>
                    </HStack>
                ) : null}
                {places.length > 0 ? (
                    <HStack space="xs">
                        <Text size="xs" className="text-typography-500">
                            {t('meraProtocol.extractedMetadataPlacesLabel')}
                        </Text>
                        <Text size="xs" className="text-typography-300 flex-1">
                            {places.join(' · ')}
                        </Text>
                    </HStack>
                ) : null}
                {entityList.length > 0 ? (
                    <HStack space="xs">
                        <Text size="xs" className="text-typography-500">
                            {t('meraProtocol.extractedMetadataEntitiesLabel')}
                        </Text>
                        <Text size="xs" className="text-typography-300 flex-1">
                            {entityList.join(' · ')}
                        </Text>
                    </HStack>
                ) : null}
            </VStack>
            <Text size="xs" className="text-typography-600 mt-2">
                {t('meraProtocol.extractedMetadataCaption')}
            </Text>
        </Box>
    );
};

export default ExtractedMetadataPanel;
