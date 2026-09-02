import {
    Accordion,
    AccordionContent,
    AccordionHeader,
    AccordionIcon,
    AccordionItem,
    AccordionTitleText,
    AccordionTrigger,
} from '@/components/ui/accordion';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useFreeTierReadOnly } from '@/components/custom/subscription/FreeTierReadOnlyBanner';
import { normPublicationName } from '@/lib/feed-grouping/geo-language-priority';
import { observeActive as observeActivePublicationPreferences } from '@/lib/database/services/publication-preference-service';
import {
    setSourcePrefFromUi,
    type SourcePrefUiLevel,
} from '@/lib/database/services/publication-pref-ui-actions';
import logger from '@/lib/logger';
import type { NewsPublisher, PublicationSource } from '@/lib/source-service';
import { SourceService } from '@/lib/source-service';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { ChevronDownIcon } from 'lucide-react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem, View } from 'react-native';
import DrillDownHeader from './DrillDownHeader';
import SourcePrefControl from './SourcePrefControl';

const formatCategory = (category: string): string =>
    category === 'general_news' ? 'All' : category;

// Humanizes the structured taxonomy slugs (`categories`) for display.
// Deliberately not translated: like `category` above, these are raw
// server-side data values rendered as-is, not UI copy. `publication_type` used
// to be folded into this same line too — it now gets its own rule-based badge
// (see `sourceKindOf`/`SourceKindBadge` below) instead, so it is deliberately
// NOT repeated here (a government source would otherwise read "Government
// source" twice on one row).
const humanizeSlug = (slug: string): string =>
    slug.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const formatCategories = (categories?: readonly string[] | null): string | null => {
    const parts = (categories ?? []).map(humanizeSlug);
    return parts.length > 0 ? parts.join(' · ') : null;
};

// -----------------------------------------------------------------------
// Item 6 — source-kind badges. A measured, deliberately narrow rule: ONLY
// `publication_type === 'government'` or `'regulator'` renders anything.
// Every other value, INCLUDING null ("not classified yet" — currently every
// prod row), renders nothing. A keyword derivation from the free-text
// `category` field was built, measured, and deleted (it badged "Android
// Authority"/"Android Police" as authorities while missing real government
// outlets) — do not reintroduce one here.
// -----------------------------------------------------------------------

type SourceKind = 'government' | 'regulator';

const SOURCE_KIND_META: Record<SourceKind, { key: string; default: string; color: string }> = {
    government: { key: 'sources.badgeGovernment', default: 'Government source', color: '#60a5fa' },
    regulator: { key: 'sources.badgeRegulator', default: 'Official agency', color: '#34d399' },
};

const sourceKindOf = (publicationType?: string | null): SourceKind | null =>
    publicationType === 'government' || publicationType === 'regulator' ? publicationType : null;

/**
 * A publisher accordion header only badges when EVERY one of its sources
 * agrees on the same recognized kind — an empty list, a null/unrecognized
 * type, or any disagreement all resolve to `null` (no badge). `sources` comes
 * from `GET_NEWS_PUBLISHERS`'s nested `publicationSources` selection, which
 * takes no `first:` (assumed complete); if the server ever paginates it this
 * would need to re-derive from a full source list instead of trusting the
 * publisher payload.
 */
const commonSourceKind = (sources: readonly PublicationSource[]): SourceKind | null => {
    if (sources.length === 0) return null;
    const first = sourceKindOf(sources[0].publication_type);
    if (!first) return null;
    return sources.every((s) => sourceKindOf(s.publication_type) === first) ? first : null;
};

const SourceKindBadge: React.FC<{ kind: SourceKind }> = ({ kind }) => {
    const { t } = useTranslation();
    const meta = SOURCE_KIND_META[kind];
    return (
        <View
            style={{
                alignSelf: 'flex-start',
                borderRadius: 6,
                borderWidth: 1,
                borderColor: `${meta.color}80`,
                paddingHorizontal: 6,
                paddingVertical: 1,
            }}
        >
            <Text size="xs" style={{ color: meta.color, letterSpacing: 0.3 }}>
                {t(meta.key, { defaultValue: meta.default })}
            </Text>
        </View>
    );
};

interface SourcesL2PublisherListProps {
    readonly countryCode: string;
    readonly countryName: string;
    readonly onBack: () => void;
}

const SourcesL2PublisherList: React.FC<SourcesL2PublisherListProps> = ({ countryCode, countryName, onBack }) => {
    const { t } = useTranslation();
    const readOnly = useFreeTierReadOnly();
    const [publishers, setPublishers] = useState<NewsPublisher[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [endCursor, setEndCursor] = useState<string | null>(null);
    const [hasNextPage, setHasNextPage] = useState(false);
    const hasFetched = useRef(false);
    // publication-name (normalized) → current level, from the SAME
    // `publication_preferences` table the dedicated Source-preferences screen
    // reads — item 9's L2 control reflects (and writes) the live state, it
    // does not keep a parallel copy of it.
    const [pubPrefLevels, setPubPrefLevels] = useState<Map<string, SourcePrefUiLevel>>(new Map());
    // Keyed by publisher._id, not name — mirrors the busy-id keying rationale
    // in PublicationPreferencesScreen (two publishers could theoretically
    // share a display name; the id never collides).
    const [busyPublisherId, setBusyPublisherId] = useState<string | null>(null);

    useEffect(() => {
        if (countryCode && !hasFetched.current) {
            hasFetched.current = true;
            loadPublishers();
        }
        // Fetch once per countryCode (guarded by hasFetched ref); loadPublishers
        // is defined below and intentionally excluded to avoid re-fetch loops.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [countryCode]);

    useEffect(() => {
        const sub = observeActivePublicationPreferences().subscribe((rows) => {
            const next = new Map<string, SourcePrefUiLevel>();
            for (const p of rows) {
                if (p.scopeKind != null) continue; // a scope row's label is never a publication name
                const name = normPublicationName(p.publicationName);
                if (!name) continue;
                // Mute (weight ≤ -0.9) collapses into 'deprioritised' for THIS
                // control's 3-state display — L2 has no unmute affordance by
                // design (item 9: mute stays exclusive to the dedicated
                // Source-preferences screen). Pressing ↑ here still lifts a
                // mute (a boost overwrites any prior weight), and pressing ↓
                // clears it to 'none' rather than reinstating the mute.
                next.set(name, p.weight > 0 ? 'prioritised' : p.weight < 0 ? 'deprioritised' : 'none');
            }
            setPubPrefLevels(next);
        });
        return () => sub.unsubscribe();
    }, []);

    const handleChangePublisherPref = useCallback(
        async (publisher: NewsPublisher, next: SourcePrefUiLevel) => {
            setBusyPublisherId(publisher._id);
            try {
                await setSourcePrefFromUi({ kind: 'publication', publicationName: publisher.name }, next);
            } catch (error) {
                logger.captureException(error, {
                    tags: { screen: 'SourcesL2PublisherList', method: 'setPublisherPref' },
                    extra: { publisherId: publisher._id, next },
                });
            } finally {
                setBusyPublisherId(null);
            }
        },
        [],
    );

    const loadPublishers = async () => {
        try {
            setIsLoading(true);
            const response = await SourceService.getNewsPublishers({
                countryCode,
                first: 5,
            });
            setPublishers(response.newsPublishers);
            setEndCursor(response.pageInfo.endCursor ?? null);
            setHasNextPage(response.pageInfo.hasNextPage);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'SourcesL2PublisherList', method: 'loadPublishers' },
                extra: { countryCode },
            });
        } finally {
            setIsLoading(false);
        }
    };

    const loadMore = useCallback(async () => {
        if (!hasNextPage || isLoadingMore || !endCursor) return;

        try {
            setIsLoadingMore(true);
            const response = await SourceService.getNewsPublishers({
                countryCode,
                first: 5,
                after: endCursor,
            });
            setPublishers((prev) => [...prev, ...response.newsPublishers]);
            setEndCursor(response.pageInfo.endCursor ?? null);
            setHasNextPage(response.pageInfo.hasNextPage);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'SourcesL2PublisherList', method: 'loadMore' },
                extra: { countryCode },
            });
        } finally {
            setIsLoadingMore(false);
        }
    }, [hasNextPage, isLoadingMore, endCursor, countryCode]);

    const handleFeedPress = useCallback(
        (feed: PublicationSource, publisherName: string) => {
            router.push({
                pathname: '/logged-in/sources-articles',
                params: { title: formatCategory(feed.category), countryCode, publisherName, publicationSourceId: feed._id },
            });
        },
        [countryCode]
    );

    const handleTopHeadlinesPress = useCallback(
        (publisher: NewsPublisher) => {
            router.push({
                pathname: '/logged-in/publisher-articles',
                params: { publisherId: publisher._id, publisherName: publisher.name },
            });
        },
        []
    );

    const renderPublisher: ListRenderItem<NewsPublisher> = useCallback(
        ({ item }) => {
            const headerBadgeKind = commonSourceKind(item.publicationSources);
            const prefLevel = pubPrefLevels.get(normPublicationName(item.name) ?? '') ?? 'none';
            const prefBusy = busyPublisherId === item._id || readOnly;
            return (
            <Box className="mx-4 mb-3">
                <Accordion type="single" isCollapsible variant="unfilled" className="border border-gray-700 rounded-lg">
                    <AccordionItem value={item._id}>
                        <AccordionHeader>
                            <AccordionTrigger className="px-4 py-3">
                                <VStack className="flex-1 mr-3" space="xs">
                                    <AccordionTitleText className="text-white text-base">
                                        {item.name}
                                    </AccordionTitleText>
                                    {item.website_url && (
                                        <Text size="xs" className="text-gray-500">
                                            {item.website_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                                        </Text>
                                    )}
                                    {headerBadgeKind && <SourceKindBadge kind={headerBadgeKind} />}
                                </VStack>
                                <SourcePrefControl
                                    testIDPrefix={`source-pref-publisher-${item._id}`}
                                    current={prefLevel}
                                    busy={prefBusy}
                                    onChange={(next) => handleChangePublisherPref(item, next)}
                                />
                                <Button
                                    variant="outline"
                                    size="xs"
                                    onPress={() => handleTopHeadlinesPress(item)}
                                    className="rounded-full mx-2"
                                >
                                    <ButtonText>{t('sources.viewTopHeadlines')}</ButtonText>
                                </Button>
                                <AccordionIcon
                                    as={ChevronDownIcon}
                                    className="text-gray-400"
                                />
                            </AccordionTrigger>
                        </AccordionHeader>
                        <AccordionContent className="px-0 pb-2 pt-0">
                            {item.publicationSources.length === 0 ? (
                                <Text size="sm" className="text-gray-500 px-4 py-2">
                                    {t('sources.noFeedsAvailable')}
                                </Text>
                            ) : (
                                item.publicationSources.map((feed) => {
                                    const feedBadgeKind = sourceKindOf(feed.publication_type);
                                    const categoriesLabel = formatCategories(feed.categories);
                                    return (
                                    <Pressable
                                        key={feed._id}
                                        onPress={() => handleFeedPress(feed, item.name)}
                                        className="px-4 py-2.5 border-t border-gray-800"
                                    >
                                        <HStack className="items-center justify-between">
                                            <VStack className="flex-1 mr-3" space="xs">
                                                <Text className="text-white text-sm capitalize">
                                                    {formatCategory(feed.category)}
                                                </Text>
                                                {feedBadgeKind && <SourceKindBadge kind={feedBadgeKind} />}
                                                {categoriesLabel && (
                                                    <Text size="xs" className="text-gray-500">
                                                        {categoriesLabel}
                                                    </Text>
                                                )}
                                            </VStack>
                                            <MaterialIcons name="chevron-right" size={18} color="#999999" />
                                        </HStack>
                                    </Pressable>
                                    );
                                })
                            )}
                        </AccordionContent>
                    </AccordionItem>
                </Accordion>
            </Box>
            );
        },
        [handleFeedPress, handleTopHeadlinesPress, handleChangePublisherPref, pubPrefLevels, busyPublisherId, readOnly, t]
    );

    const keyExtractor = useCallback(
        (item: NewsPublisher, index: number) => item._id || `pub-${index}`,
        []
    );

    const ListFooterComponent = useCallback(() => {
        if (isLoadingMore) {
            return (
                <Box className="items-center py-4">
                    <Spinner size="small" />
                </Box>
            );
        }
        return null;
    }, [isLoadingMore]);

    return (
        <Box className="flex-1">
            <DrillDownHeader title={countryName ?? t('sources.publishers')} onBack={onBack} />

            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : publishers.length === 0 ? (
                <VStack className="flex-1 items-center justify-center p-6" space="md">
                    <MaterialIcons name="newspaper" size={48} color="#666666" />
                    <Text size="md" className="text-gray-400 text-center">
                        {t('sources.noPublishers')}
                    </Text>
                </VStack>
            ) : (
                <FlatList
                    data={publishers}
                    renderItem={renderPublisher}
                    keyExtractor={keyExtractor}
                    contentContainerStyle={{ paddingTop: 12, paddingBottom: 20 }}
                    showsVerticalScrollIndicator={false}
                    onEndReached={loadMore}
                    onEndReachedThreshold={0.5}
                    ListFooterComponent={ListFooterComponent}
                />
            )}

        </Box>
    );
};

export default SourcesL2PublisherList;
