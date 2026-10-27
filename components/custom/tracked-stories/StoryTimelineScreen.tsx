import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { ActionSheetRow } from '@/components/custom/cards/ArticleOverflowMenu';
import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import ExportWizardModal from '@/components/custom/saved-suggestions/ExportWizardModal';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Box } from '@/components/ui/box';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { hapticLight } from '@/lib/haptics';
import { formatDayMonth } from '@/lib/stats/visited-publications';
import { useColors } from '@/lib/theme/tokens';
import { timelineCardToArticle, type TimelineEntry } from './merge-timeline';
import { type TimelineRow, useStoryTimelineScreen } from './useStoryTimelineScreen';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import RestoreReveal from '@/components/custom/nav/RestoreReveal';
import { useScreenScrollTarget } from '@/lib/navigation/use-screen-scroll-target';
import { notifyScrollTick } from '@/lib/visibility-tick';

/** A 44pt header button, numeric (never hitSlop). */
const HEADER_BUTTON = { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' } as const;


interface StoryTimelineScreenProps {
    trackedStoryId: string;
    onBack: () => void;
}

/**
 * A tracked story's timeline — the coverage gathered under its tracked topic,
 * newest-first. A followed story is just a topic: its members are the local
 * snapshots seeded at track time and grown by the topic reconcile each fetch
 * cycle (there is no server archive). Marks the story seen on every focus
 * (clears its unseen badge) and re-reads the local row on focus +
 * pull-to-refresh. The header renders the display label / headline (falling back
 * to the tracked title). Until the reconcile adds more members, a freshly
 * followed story shows only its originating article; a quiet note stands in when
 * empty.
 *
 * After each SUCCESSFUL load, the newest pubDate on screen is stamped as the
 * story's seen watermark (schema v44) so the reconcile counts only members
 * published after it toward the "N new" badge — backfilled OLD articles no
 * longer inflate the count.
 */
const StoryTimelineScreen: React.FC<StoryTimelineScreenProps> = ({ trackedStoryId, onBack }) => {
    const { t, i18n } = useTranslation();
    const appLanguage = i18n?.language ?? 'en';
    const insets = useSafeAreaInsets();
    const colors = useColors();
    const listRef = useRef<FlatList>(null);
    const yRef = useRef(0);
    const { restoreHidden } = useScreenScrollTarget(listRef, { getOffset: () => yRef.current });
    const {
        headline,
        stableClusterId,
        entries,
        isLoading,
        refreshing,
        emptyReason,
        followedSinceMs,
        menuOpen,
        setMenuOpen,
        stopPicked,
        confirmDelete,
        setConfirmDelete,
        confirmRemove,
        setConfirmRemove,
        exportOpen,
        setExportOpen,
        exportPicked,
        newAtOpen,
        handleConfirmDelete,
        handleConfirmRemove,
        load,
        onFocus,
        handleArticlePress,
        exportRows,
        buildExport,
        handleExportFailed,
        rows,
    } = useStoryTimelineScreen({ trackedStoryId, onBack });

    useFocusEffect(
        onFocus,
    );


    const renderCard = useCallback(
        (entry: TimelineEntry) => {
            const item = entry.head;
            const article = timelineCardToArticle(item);
            const askRemove = () => {
                hapticLight();
                setConfirmRemove(entry);
            };
            return (
                <ArticleStandaloneCompactCard
                    testID={`story-timeline-card-${item.articleId}`}
                    article={article}
                    similarCount={entry.copies.length}
                    onPress={() => handleArticlePress(item.articleId, stableClusterId)}
                    // Disowning a card: long-press (kept, matching the
                    // Followed-stories list one screen up) and the ••• menu's
                    // "Not part of this story", both through the same confirm.
                    onLongPress={askRemove}
                    menuExtraItems={[
                        {
                            key: 'remove-from-story',
                            label: t('trackedStories.removeMemberAction'),
                            icon: 'remove-circle-outline',
                            testID: 'menu-remove-from-story',
                            run: askRemove,
                        },
                    ]}
                    subjectExtras={{
                        surface: 'tracked',
                        stableClusterId: stableClusterId ?? undefined,
                    }}
                />
            );
        },
        [handleArticlePress, stableClusterId, t],
    );

    const renderItem: ListRenderItem<TimelineRow> = useCallback(
        ({ item }) =>
            item.kind === 'day' ? (
                <Text
                    accessibilityRole="header"
                    style={{ color: colors.ink3, fontSize: 13, fontWeight: '600', marginTop: 8, marginBottom: 8 }}
                >
                    {item.label}
                </Text>
            ) : (
                renderCard(item.entry)
            ),
        [renderCard, colors.ink3],
    );

    const keyExtractor = useCallback(
        (item: TimelineRow, index: number) =>
            item.kind === 'day' ? item.key : item.entry.head.articleId || `snap-${index}`,
        [],
    );

    // What comes next (FinalRead #16): under the coverage, and on its own
    // when there is none yet.
    const nextNote = (
        <HStack className="items-center px-1 py-4" space="sm" testID="story-timeline-next">
            <MaterialIcons name="history" size={18} color={colors.ink3} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
            <Text size="sm" style={{ color: colors.ink3, flex: 1 }}>
                {t('trackedStories.nextNote')}
            </Text>
        </HStack>
    );

    const ListEmpty = isLoading ? (
        <Box className="items-center justify-center py-20">
            <Spinner size="large" />
        </Box>
    ) : emptyReason === 'quiet' ? (
        nextNote
    ) : (
        <Box className="items-center justify-center py-20 px-8" testID={`story-timeline-${emptyReason}`}>
            <MaterialIcons name="error-outline" size={40} color={colors.ink2} />
            <Text size="sm" className="text-ink-3 text-center mt-4">
                {emptyReason === 'gone'
                    ? t('articleDetail.storyUnavailable')
                    : t('trackedStories.timelineLoadFailed')}
            </Text>
        </Box>
    );

    return (
        // No opaque fill: the AbstractGradientBackdrop below is the page background.
        <Box className="flex-1">
            {/* Page background. Must be the FIRST child so it paints behind
                everything else on the page. */}
            <AbstractGradientBackdrop />

            <VStack style={{ paddingTop: insets.top + 8 }}>
                <HStack className="items-center px-2 pb-2" space="sm">
                    <Pressable
                        onPress={onBack}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.back')}
                        style={HEADER_BUTTON}
                    >
                        <MaterialIcons name="arrow-back" size={24} color={colors.ink} />
                    </Pressable>
                    <Box className="flex-1 min-w-0 pr-3">
                        {!!headline && (
                            <TranslatableDynamic
                                text={headline}
                                as="heading"
                                size="xl"
                                numberOfLines={2}
                                className="text-ink"
                            />
                        )}
                        {/* Followed since, article and new counts. No "Headlines written
                            by Mera" here (owner); the Stories list carries the AI line, and
                            an export still labels AI headlines. Wraps, never truncates. */}
                        {followedSinceMs || entries.length > 0 ? (
                            <Text size="xs" style={{ color: colors.ink3, marginTop: 2 }}>
                                {[
                                    followedSinceMs
                                        ? t('trackedStories.followedSince', {
                                              date: formatDayMonth(followedSinceMs, appLanguage),
                                          })
                                        : null,
                                    entries.length > 0 ? t('trackedStories.articlesCount', { count: entries.length }) : null,
                                    newAtOpen > 0 ? t('trackedStories.updatesBadge', { count: newAtOpen }) : null,
                                ]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </Text>
                        ) : null}
                    </Box>
                    {/* Stopping is the ONLY way to unfollow a story (Q13): it
                        destroys everything saved here, hence the confirm. */}
                    <Pressable
                        testID="story-timeline-more"
                        onPress={() => setMenuOpen(true)}
                        accessibilityRole="button"
                        accessibilityLabel={t('articleMenu.openA11y')}
                        style={HEADER_BUTTON}
                    >
                        <MaterialIcons name="more-horiz" size={24} color={colors.ink} />
                    </Pressable>
                </HStack>
            </VStack>

            <BottomSheet
                open={menuOpen}
                onClose={() => setMenuOpen(false)}
                // The confirm opens once the sheet has fully gone: iOS refuses
                // a second modal over one still leaving.
                onClosed={() => {
                    if (exportPicked.current) {
                        exportPicked.current = false;
                        setExportOpen(true);
                        return;
                    }
                    if (!stopPicked.current) return;
                    stopPicked.current = false;
                    setConfirmDelete(true);
                }}
                testID="story-timeline-menu"
            >
                {/* Export, moved here from the header (owner). Only when there
                    is something to export, so it never opens an empty wizard. */}
                {!isLoading && exportRows.length > 0 ? (
                    <ActionSheetRow
                        testID="story-timeline-share"
                        label={t('storyExport.shareA11y')}
                        icon="ios-share"
                        onPress={() => {
                            exportPicked.current = true;
                            setMenuOpen(false);
                        }}
                    />
                ) : null}
                <ActionSheetRow
                    testID="story-timeline-stop"
                    label={t('trackedStories.stopFollowing')}
                    icon="remove-circle-outline"
                    destructive
                    onPress={() => {
                        stopPicked.current = true;
                        setMenuOpen(false);
                    }}
                />
            </BottomSheet>

            <ConfirmDialog
                open={confirmDelete}
                title={t('trackedStories.stopFollowingConfirmTitle')}
                body={t('trackedStories.stopFollowingConfirmBody')}
                confirmLabel={t('trackedStories.stopFollowing')}
                destructive
                onConfirm={handleConfirmDelete}
                onCancel={() => setConfirmDelete(false)}
                testID="story-timeline-delete"
            />

            {/* "Not part of this story": drops ONE article and leaves the
                story followed. */}
            <ConfirmDialog
                open={!!confirmRemove}
                title={t('trackedStories.removeMemberConfirmTitle')}
                body={t('trackedStories.removeMemberConfirmBody')}
                confirmLabel={t('trackedStories.removeMemberAction')}
                destructive
                onConfirm={handleConfirmRemove}
                onCancel={() => setConfirmRemove(null)}
                testID="story-timeline-card-remove"
            />

            <ExportWizardModal
                isOpen={exportOpen}
                onClose={() => setExportOpen(false)}
                rows={exportRows}
                buildContent={buildExport}
                onFailed={handleExportFailed}
                dialogTitle={t('storyExport.shareDialogTitle')}
                reasonHint={t('storyExport.includeReasonHint')}
                testIDPrefix="story-export"
                initiallyAllSelected
                fileBaseName="mera-story"
            />

            <RestoreReveal hidden={restoreHidden}>
            <FlatList
                ref={listRef}
                // Rows below the first screen ask for their translation only
                // when a scroll tick finds them on screen (lib/visibility-tick).
                onScroll={(e) => {
                    yRef.current = e.nativeEvent.contentOffset.y;
                    notifyScrollTick();
                }}
                scrollEventThrottle={16}
                onContentSizeChange={notifyScrollTick}
                data={rows}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                ListEmptyComponent={ListEmpty}
                ListFooterComponent={entries.length > 0 ? nextNote : null}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={() => load({ isRefresh: true })}
                        tintColor={colors.accent}
                        colors={[colors.accent]}
                    />
                }
                contentContainerStyle={{
                    paddingTop: 8,
                    // F35: the same 16pt side margins as Explore's list; the
                    // cards ran edge to edge.
                    paddingHorizontal: 16,
                    paddingBottom: insets.bottom + 40,
                    flexGrow: 1,
                }}
                showsVerticalScrollIndicator={false}
            />
            </RestoreReveal>
        </Box>
    );
};

export default StoryTimelineScreen;
