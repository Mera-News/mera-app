// One of Saved's two lists over compact rows that scale. Read later is the
// Library's Saved page, under the pinned title row with Group by, Archive and
// Export. Archive is the same screen pushed in the Library stack (ArchiveScreen).
//
// No delete circle on the rows: removing or moving is the compact row's •••,
// which publishes the change (lib/saved-state). The rows are derived from those
// overrides, so a row and its group heading leave at once and a moved row is in
// the other list without a reload. The list then settles to the top if what is
// left fits: on iOS a list that shrinks below its viewport keeps its old offset
// otherwise, with nothing left to scroll back by.

import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import { ArticleSuggestionCompactCard } from '@/components/custom/cards/ArticleSuggestionCompactCard';
import type { PickableFact } from '@/components/custom/feedback-tree/pick-fact';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import { openTutorial } from '@/components/custom/tutorials/open-tutorial';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import MeraToast from '@/components/custom/toast/MeraToast';
import { useToast } from '@/components/ui/toast';
import { getFacts } from '@/lib/database/services/fact-service';
import { loadSavedItems, type SavedItem } from '@/lib/database/services/saved-article-suggestion-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import {
    getSavedListOverride,
    getSavedOverride,
    useSavedStateVersion,
    type SavedList,
} from '@/lib/saved-state';
import { useColors } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ListRenderItem } from 'react-native';
import Animated, { type SharedValue, useAnimatedScrollHandler } from 'react-native-reanimated';
import SavedExportModal from './SavedExportModal';
import SavedExportRow, { SAVED_PINNED_HEIGHT } from './SavedExportRow';
import {
    groupSavedItems,
    parseGroupBy,
    SAVED_GROUP_BY_SETTING,
    type PriorityBand,
    type SavedGroupBy,
    type SavedGroupHeading,
} from './saved-groups';
import { savedItemId } from './saved-item-id';
import { PAGE_CONTENT_GAP, PAGE_SIDE_INSET } from '@/components/custom/nav/page-registry';
import { usePageScrollTarget } from '@/components/custom/nav/page-scroll';
import { useTrackedScroll } from '@/components/custom/nav/use-tracked-scroll';

interface SavedSuggestionsScreenProps {
    /** Read later or Archive. */
    list: SavedList;
    /** The tab's collapsing-header scroll handler (an Animated.FlatList's). */
    scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
    /** The tab header's height; the pinned row sits under it. */
    headerHeight?: number;
    /** The header's 0..1 collapse value; the pinned row rides with it. */
    hidden?: SharedValue<number>;
    /** List-end padding (the tab bar and the Mera button). */
    listEndPadding?: number;
    /** False while Saved is a warmed neighbour: no scroll ticks. */
    active?: boolean;
}

type Row =
    | { readonly kind: 'heading'; readonly key: string; readonly heading: SavedGroupHeading }
    | { readonly kind: 'item'; readonly key: string; readonly item: SavedItem };

/** The chip's short "Med" reads wrong as a heading: these are the spoken names. */
const BAND_KEY = {
    EMERGENCY: 'relevance.a11yEmergency',
    HIGH: 'relevance.a11yHigh',
    MEDIUM: 'relevance.a11yMedium',
    LOW: 'relevance.a11yLow',
} as const satisfies Record<PriorityBand, string>;

const SavedRow: React.FC<{ readonly item: SavedItem }> = ({ item }) =>
    item.origin === 'article' ? (
        <ArticleStandaloneCompactCard
            article={item.article}
            onPress={() => router.push({ pathname: '/logged-in/article-detail', params: { articleId: item.article._id } })}
            subjectExtras={{ surface: 'saved' }}
            testID={`saved-item-${savedItemId(item)}`}
        />
    ) : (
        <ArticleSuggestionCompactCard
            suggestion={item.suggestion}
            onPress={(s) =>
                router.push({ pathname: '/logged-in/suggestion-detail', params: { articleSuggestionId: s._id } })
            }
            surface="saved"
        />
    );

const GroupHeading: React.FC<{ readonly heading: SavedGroupHeading; readonly testID: string }> = ({ heading, testID }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const label =
        heading.kind === 'fact'
            ? heading.statement
            : heading.kind === 'band'
              ? t(BAND_KEY[heading.band])
              : heading.kind === 'no-priority'
                ? t('library.saved.groupNoPriority')
                : t('library.saved.groupOther');
    return (
        <Text
            testID={testID}
            accessibilityRole="header"
            numberOfLines={2}
            style={{ fontSize: 15, lineHeight: 20, fontWeight: '600', color: colors.ink2, paddingTop: 12, paddingBottom: 8 }}
        >
            {label}
        </Text>
    );
};

const SavedSuggestionsScreen: React.FC<SavedSuggestionsScreenProps> = ({
    list,
    scrollHandler,
    headerHeight = 0,
    hidden,
    listEndPadding,
    active = true,
}) => {
    const { t } = useTranslation();
    const toast = useToast();
    const tabClearance = useTabBarClearance();
    const [saved, setSaved] = useState<SavedItem[]>([]);
    const [facts, setFacts] = useState<readonly PickableFact[]>([]);
    const [groupBy, setGroupBy] = useState<SavedGroupBy>('newest');
    const [isLoading, setIsLoading] = useState(true);
    const [exportOpen, setExportOpen] = useState(false);

    const listRef = useRef<any>(null);
    const scrollToTop = useCallback(() => listRef.current?.scrollToOffset?.({ offset: 0, animated: false }), []);
    // Bumped by a pick, so a focus load already running cannot undo it.
    const groupPicks = useRef(0);

    useFocusEffect(
        useCallback(() => {
            let cancelled = false;
            const picksAtStart = groupPicks.current;
            (async () => {
                const [rows, stored] = await Promise.all([loadSavedItems(), getSetting(SAVED_GROUP_BY_SETTING)]);
                const mode = parseGroupBy(stored);
                // Read together, so the first paint is already the reader's view.
                const factRows = mode === 'facts' ? await getFacts() : [];
                if (cancelled) return;
                setSaved(rows);
                if (groupPicks.current !== picksAtStart) return;
                setGroupBy(mode);
                setFacts(factRows);
            })()
                .catch((err) => {
                    logger.captureException(err, { tags: { screen: 'SavedSuggestionsScreen', method: 'load' } });
                })
                .finally(() => {
                    if (!cancelled) setIsLoading(false);
                });
            return () => {
                cancelled = true;
            };
        }, []),
    );

    const handleGroupByChange = useCallback(
        (next: SavedGroupBy) => {
            groupPicks.current += 1;
            void (async () => {
                if (next === 'facts') setFacts(await getFacts());
                setGroupBy(next);
                scrollToTop();
                await setSetting(SAVED_GROUP_BY_SETTING, next);
            })().catch((err) => {
                logger.captureException(err, { tags: { screen: 'SavedSuggestionsScreen', method: 'groupBy' } });
            });
        },
        [scrollToTop],
    );

    const handleExportFailed = useCallback(() => {
        toast.show({
            duration: 4000,
            render: () => (
                <MeraToast
                    tone="error"
                    title={t('savedExport.failedTitle')}
                    body={t('savedExport.failedMessage')}
                />
            ),
        });
    }, [toast, t]);

    const stateVersion = useSavedStateVersion();
    // What this list holds now, and what Export offers. `stateVersion` is what
    // makes the overrides read here current.
    const visible = useMemo(
        () =>
            saved.filter((it) => {
                const id = savedItemId(it);
                return getSavedOverride(id) !== false && (getSavedListOverride(id) ?? it.list) === list;
            }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [saved, list, stateVersion],
    );
    const rows = useMemo(() => {
        const out: Row[] = [];
        for (const group of groupSavedItems(visible, groupBy, facts)) {
            if (group.heading) out.push({ kind: 'heading', key: group.key, heading: group.heading });
            for (const item of group.items) out.push({ kind: 'item', key: savedItemId(item), item });
        }
        return out;
    }, [visible, groupBy, facts]);

    const renderItem: ListRenderItem<Row> = useCallback(
        ({ item }) =>
            item.kind === 'heading' ? (
                <GroupHeading heading={item.heading} testID={`saved-group-${item.key}`} />
            ) : (
                <SavedRow item={item.item} />
            ),
        [],
    );
    const keyExtractor = useCallback((row: Row, index: number) => row.key || `saved-${index}`, []);

    // The tab's re-tap scrolls this page to the top (nav/page-scroll).
    const tracked = useTrackedScroll(scrollHandler);
    usePageScrollTarget(listRef, { getOffset: tracked.getOffset });
    const viewportH = useRef(0);
    const settleIfShort = useCallback(
        (_w: number, contentH: number) => {
            if (active) notifyScrollTick();
            if (viewportH.current > 0 && contentH <= viewportH.current) {
                listRef.current?.scrollToOffset?.({ offset: 0, animated: true });
            }
        },
        [active],
    );

    // Everything removed this visit: the empty state, without a reload.
    const ListEmpty = isLoading ? (
        <Box className="items-center justify-center py-20">
            <Spinner size="large" />
        </Box>
    ) : list === 'archive' ? (
        <ForYouEmptyState
            icon="archive"
            title={t('library.saved.emptyArchiveTitle')}
            body={t('library.saved.emptyArchiveBody')}
            testID="saved-empty-archive"
        />
    ) : (
        <ForYouEmptyState
            icon="bookmark-border"
            title={t('savedSuggestions.emptyTitle')}
            body={t('library.saved.emptyBody')}
            action={{ label: t('library.saved.learn'), onPress: () => openTutorial('library', 'saved'), testID: 'saved-learn' }}
            testID="saved-empty"
        />
    );

    // Pinned on Read later, where it rides with the tab header. Archive has a
    // fixed header and no such ride, so there it scrolls with the rows.
    const pinned = list === 'later';
    const exportRow = isLoading ? undefined : (
        <SavedExportRow
            list={list}
            groupBy={groupBy}
            onGroupByChange={handleGroupByChange}
            hasRows={visible.length > 0}
            headerHeight={headerHeight}
            hidden={hidden}
            onOpenArchive={() => router.push('/logged-in/app_container/library/archive')}
            onExport={() => setExportOpen(true)}
        />
    );

    return (
        <Box className="flex-1">
            <Animated.FlatList
                ref={listRef}
                testID="saved-suggestions-list"
                data={rows}
                onLayout={(e) => {
                    viewportH.current = e.nativeEvent.layout.height;
                }}
                onContentSizeChange={settleIfShort}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                ListHeaderComponent={pinned ? undefined : exportRow}
                ListEmptyComponent={ListEmpty}
                contentContainerStyle={{
                    // 12pt below the pinned row.
                    paddingTop: headerHeight + (pinned && !isLoading ? SAVED_PINNED_HEIGHT : 0) + PAGE_CONTENT_GAP,
                    paddingHorizontal: PAGE_SIDE_INSET,
                    paddingBottom: listEndPadding ?? tabClearance + 24,
                    flexGrow: 1,
                }}
                showsVerticalScrollIndicator={false}
                onScroll={scrollHandler ? tracked.onScroll : notifyScrollTick}
                scrollEventThrottle={16}
            />

            {/* Pinned under the page header; the list scrolls beneath it. */}
            {pinned ? exportRow : null}

            <SavedExportModal
                isOpen={exportOpen}
                onClose={() => setExportOpen(false)}
                items={visible}
                onFailed={handleExportFailed}
            />
        </Box>
    );
};

export default SavedSuggestionsScreen;
