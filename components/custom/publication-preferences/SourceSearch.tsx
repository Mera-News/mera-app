import { flagForAlpha2, alpha3ToAlpha2 } from '@/components/custom/locations/location-display';
import { HStack } from '@/components/ui/hstack';
import { Input, InputField, InputSlot } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { PublicationPrefKind } from '@/lib/database/services/publication-preference-service';
import { rememberPublisherSourceNames, resolvePublicationPrefNames } from '@/lib/database/services/publisher-source-names';
import type { PublisherSearchHit } from '@/lib/generated/graphql-types';
import { useDebouncedValue } from '@/lib/hooks/use-debounced-value';
import logger from '@/lib/logger';
import SourceService from '@/lib/source-service';
import { resolveSubscriptionSourceNames } from '@/lib/subscriptions/publisher-sources';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeForTestId, SourceKindChoices } from './PublicationPrefRow';
import { setPublisherKind } from './set-publisher-kind';

/** The server rejects a shorter query (BadRequestException). */
const MIN_QUERY_LENGTH = 2;

/** Every name the publisher is written under: its sources from the server,
 *  else what the device already knows. */
async function namesForHit(hit: PublisherSearchHit): Promise<string[]> {
    try {
        const names = await resolveSubscriptionSourceNames(hit._id, hit.name);
        rememberPublisherSourceNames(hit._id, names);
        return names;
    } catch {
        return resolvePublicationPrefNames({ publisherId: hit._id, publisherName: hit.name });
    }
}

/**
 * "Find a publication" on the Sources screen. A result opens More / Fewer /
 * Mute in place; once set, the publication joins the Adjusted list below.
 * Every state is named (too short, searching, none, failed): a search box
 * that shows nothing reads as broken. Nothing typed is stored.
 */
const SourceSearch: React.FC = () => {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const debounced = useDebouncedValue(query, 300);
    const [results, setResults] = useState<PublisherSearchHit[]>([]);
    const [searching, setSearching] = useState(false);
    const [searched, setSearched] = useState(false);
    const [failed, setFailed] = useState(false);
    const [openId, setOpenId] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);

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

    const pick = async (hit: PublisherSearchHit, kind: PublicationPrefKind) => {
        setBusyId(hit._id);
        try {
            await setPublisherKind(await namesForHit(hit), kind);
            setOpenId(null);
        } catch (error) {
            logger.captureException(error, { tags: { component: 'SourceSearch', method: 'pick' }, extra: { kind } });
        } finally {
            setBusyId(null);
        }
    };

    const typed = query.trim().length > 0;
    const tooShort = typed && trimmed.length < MIN_QUERY_LENGTH;

    return (
        <VStack space="sm" className="px-4 pb-2">
            <Input className="rounded-full border-white/10 bg-white/5" style={{ height: 42 }}>
                <InputSlot className="pl-3.5">
                    <MaterialIcons name="search" size={18} color="#A3A3A3" />
                </InputSlot>
                <InputField
                    testID="sources-search"
                    value={query}
                    onChangeText={setQuery}
                    placeholder={t('you.sources.find')}
                    accessibilityLabel={t('you.sources.find')}
                    autoCapitalize="none"
                    autoCorrect={false}
                />
            </Input>

            {tooShort ? <Text size="sm" className="text-gray-400">{t('subscriptions.searchTooShort')}</Text> : null}
            {!tooShort && searching ? (
                <HStack space="sm" className="items-center">
                    <Spinner size="small" />
                    <Text size="sm" className="text-gray-400">{t('subscriptions.searchInFlight')}</Text>
                </HStack>
            ) : null}
            {failed && !searching ? <Text size="sm" className="text-gray-400">{t('subscriptions.searchError')}</Text> : null}
            {!failed && !searching && searched && results.length === 0 ? (
                <Text size="sm" className="text-gray-400">{t('subscriptions.searchNoResults')}</Text>
            ) : null}

            {!tooShort && !searching
                ? results.map((hit) => {
                    const idBase = `sources-hit-${normalizeForTestId(hit.name)}`;
                    const open = openId === hit._id;
                    return (
                        <VStack key={hit._id} space="xs">
                            <Pressable
                                testID={idBase}
                                onPress={() => setOpenId(open ? null : hit._id)}
                                accessibilityRole="button"
                                accessibilityLabel={hit.name}
                                accessibilityState={{ expanded: open }}
                                className="flex-row items-center"
                                style={{ minHeight: 44 }}
                            >
                                <Text size="md">{flagForAlpha2(alpha3ToAlpha2(hit.country_code))}</Text>
                                <Text size="md" className="text-white flex-1 ml-2" numberOfLines={1}>{hit.name}</Text>
                                <MaterialIcons name={open ? 'expand-less' : 'expand-more'} size={20} color="#9ca3af" />
                            </Pressable>
                            {open ? (
                                <SourceKindChoices
                                    idBase={idBase}
                                    current={null}
                                    busy={busyId === hit._id}
                                    allowMute
                                    onPick={(kind) => void pick(hit, kind)}
                                />
                            ) : null}
                        </VStack>
                    );
                })
                : null}
        </VStack>
    );
};

export default SourceSearch;
