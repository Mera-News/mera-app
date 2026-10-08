import { alpha3ToAlpha2, flagForAlpha2 } from '@/components/custom/locations/location-display';
import PublicationListRow from '@/components/custom/publication-page/PublicationListRow';
import { openPublicationPage } from '@/components/custom/publication-page/open-publication-page';
import { HStack } from '@/components/ui/hstack';
import { Input, InputField, InputSlot } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { PublisherSearchHit } from '@/lib/generated/graphql-types';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import logger from '@/lib/logger';
import SourceService from '@/lib/source-service';
import { MaterialIcons } from '@expo/vector-icons';
import { useColors, useThemeMode } from '@/lib/theme/tokens';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** The server rejects a shorter query (BadRequestException). */
const MIN_QUERY_LENGTH = 2;

/**
 * "Find a publication" on the Sources screen. A result is the slim
 * publication row and opens the publication page, where every tag is set;
 * once tagged, the publication joins the list below. Every state is named
 * (too short, searching, none, failed): a search box that shows nothing reads
 * as broken. Nothing typed is stored.
 */
const SourceSearch: React.FC<{
    /** True while the box holds a query, so the screen can hide its empty state. */
    readonly onActiveChange?: (active: boolean) => void;
}> = ({ onActiveChange }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const themeMode = useThemeMode();
    const [query, setQuery] = useState('');
    const debounced = useDebouncedValue(query, 300);
    const [results, setResults] = useState<PublisherSearchHit[]>([]);
    const [searching, setSearching] = useState(false);
    const [searched, setSearched] = useState(false);
    const [failed, setFailed] = useState(false);

    const trimmed = debounced.trim();
    useEffect(() => {
        if (trimmed.length < MIN_QUERY_LENGTH) {
            setResults([]);
            setSearched(false);
            setFailed(false);
            return undefined;
        }
        let cancelled = false;
        setSearching(true);
        setFailed(false);
        SourceService.searchPublishers({ query: trimmed, first: 20 })
            .then((res) => {
                if (cancelled) return;
                setResults(res.publishers ?? []);
                setSearched(true);
            })
            .catch((error) => {
                if (cancelled) return;
                setFailed(true);
                setResults([]);
                logger.captureException(error, { tags: { component: 'SourceSearch', method: 'searchPublishers' } });
            })
            .finally(() => {
                if (!cancelled) setSearching(false);
            });
        return () => {
            cancelled = true;
        };
    }, [trimmed]);

    const typed = query.trim().length > 0;
    const tooShort = typed && trimmed.length < MIN_QUERY_LENGTH;
    useEffect(() => {
        onActiveChange?.(typed);
    }, [typed, onActiveChange]);

    return (
        <VStack className="pb-2">
            <VStack space="sm" className="px-4 pb-3">
                <Input className="rounded-full border-line bg-surface" style={{ height: 42 }}>
                    <InputSlot className="pl-3.5">
                        <MaterialIcons name="search" size={18} color={colors.ink2} />
                    </InputSlot>
                    <InputField
                        keyboardAppearance={themeMode}
                        testID="sources-search"
                        value={query}
                        onChangeText={setQuery}
                        placeholder={t('you.sources.find')}
                        accessibilityLabel={t('you.sources.find')}
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                </Input>

                {tooShort ? <Text size="sm" className="text-ink-2">{t('subscriptions.searchTooShort')}</Text> : null}
                {!tooShort && searching ? (
                    <HStack space="sm" className="items-center">
                        <Spinner size="small" />
                        <Text size="sm" className="text-ink-2">{t('subscriptions.searchInFlight')}</Text>
                    </HStack>
                ) : null}
                {failed && !searching ? <Text size="sm" className="text-ink-2">{t('subscriptions.searchError')}</Text> : null}
                {!failed && !searching && searched && results.length === 0 ? (
                    <Text size="sm" className="text-ink-2">{t('subscriptions.searchNoResults')}</Text>
                ) : null}
            </VStack>

            {!tooShort && !searching
                ? results.map((hit) => (
                      <PublicationListRow
                          key={hit._id}
                          rawName={hit.name}
                          flag={flagForAlpha2(alpha3ToAlpha2(hit.country_code)) || null}
                          subtitle={hit.country_name ?? null}
                          prefLevel="none"
                          onPress={() =>
                              openPublicationPage({ publisherId: hit._id, rawName: hit.name, countryCode: hit.country_code })
                          }
                          testID={`sources-hit-${hit._id}`}
                      />
                  ))
                : null}
        </VStack>
    );
};

export default SourceSearch;
