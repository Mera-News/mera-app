// The Feed tab's Stories page (FinalFeedStatus #6-8): every followed story,
// live via `observeActive` (unseen first, newest next).
//
// A row: the story's title with a tinted "N new" on the right, its latest
// headline (the newest CURRENT member, translated from its original), then
// "Publisher · updated 1h ago". No follow button here (the Mera button and
// articles follow a story) and no trash icon (owner default F1): a long press
// opens a small sheet with Stop following, and screen readers get the same
// as an action. One AI line under the rows says whether every title is
// AI-written or only some (owner default F2: never claim all unless true).

import AiDisclosureCaption from '@/components/custom/AiDisclosureCaption';
import { ActionSheetRow } from '@/components/custom/cards/ArticleOverflowMenu';
import FlatCardSurface from '@/components/custom/cards/FlatCardSurface';
import PressableCard from '@/components/custom/cards/PressableCard';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { openTutorial } from '@/components/custom/tutorials/open-tutorial';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type TrackedStoryModel from '@/lib/database/models/TrackedStory';
import { observeActive } from '@/lib/database/services/tracked-story-service';
import { hapticLight } from '@/lib/haptics';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { useColors } from '@/lib/theme/tokens';
import { toastManager } from '@/lib/toast-manager';
import { deleteTrackedStoryById } from '@/lib/tracking/track-actions';
import { formatTimeAgo } from '@/lib/utils/time-ago';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ListRenderItem, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated';
import { latestMember } from './merge-timeline';

interface TrackedStoriesScreenProps {
    /** The tab's collapsing-header scroll handler (an Animated.FlatList's). */
    readonly scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
    /** The tab header's height: the list's top padding. */
    readonly headerHeight?: number;
    /** False while this is not the visible page of the focused Feed tab. */
    readonly active?: boolean;
    /** The page's title row ("Followed stories" + ?), the list's first item. */
    readonly listHeader?: React.ReactElement;
}

const TrackedStoriesScreen: React.FC<TrackedStoriesScreenProps> = ({
    scrollHandler,
    headerHeight = 0,
    active = true,
    listHeader,
}) => {
    const { t } = useTranslation();
    const c = useColors();
    const listEndClearance = useListEndClearance();
    const [stories, setStories] = useState<TrackedStoryModel[]>([]);
    const [menuTarget, setMenuTarget] = useState<TrackedStoryModel | null>(null);
    const [confirmTarget, setConfirmTarget] = useState<TrackedStoryModel | null>(null);
    const stopPicked = useRef<TrackedStoryModel | null>(null);

    useEffect(() => {
        const sub = observeActive().subscribe({
            next: (rows) => setStories(rows),
            error: () => setStories([]),
        });
        return () => sub.unsubscribe();
    }, []);

    const openTimeline = useCallback((story: TrackedStoryModel) => {
        router.push({ pathname: '/logged-in/story-timeline', params: { trackedStoryId: story.id } });
    }, []);

    const handleConfirmUntrack = useCallback(async () => {
        if (!confirmTarget) return;
        const id = confirmTarget.id;
        setConfirmTarget(null);
        // deleteTrackedStoryById, not untrackStory: the latter leaves the linked
        // TOPIC active, so the story's coverage kept being fetched.
        const deleted = await deleteTrackedStoryById(id);
        // The live query drops the row on success; on failure say why it stayed.
        if (!deleted) toastManager.showError(t('errors.somethingWentWrong'), t('trackedStories.deleteFailed'));
    }, [confirmTarget, t]);

    const renderItem: ListRenderItem<TrackedStoryModel> = useCallback(
        ({ item }) => {
            const title = item.llmHeadline ?? item.fallbackTitle;
            const isLlmHeadline = !!item.llmHeadline;
            const unseen = item.unseenCount ?? 0;
            const latest = latestMember(item.memberSnapshots, item.memberArticleIds);
            const updated = t('trackedStories.updatedAgo', {
                time: formatTimeAgo(t, item.lastUpdateAt ?? item.createdAt),
            });
            const meta = [latest?.publicationName, updated].filter(Boolean).join(' · ');
            return (
                <PressableCard
                    onPress={() => openTimeline(item)}
                    onLongPress={() => {
                        hapticLight();
                        setMenuTarget(item);
                    }}
                    // The row is ONE accessibility element; Stop following
                    // reaches screen readers as its action.
                    accessibilityActions={[{ name: 'untrack', label: t('trackedStories.stopFollowing') }]}
                    onAccessibilityAction={(e) => {
                        if (e.nativeEvent.actionName === 'untrack') setConfirmTarget(item);
                    }}
                    accessibilityRole="button"
                    // Visual order: title (with its AI flag for a reader who
                    // lands mid-list and never hears the list's AI line), new
                    // count, latest headline, meta.
                    accessibilityLabel={[
                        title,
                        isLlmHeadline ? t('aiDisclosure.short') : null,
                        unseen > 0 ? t('trackedStories.updatesBadge', { count: unseen }) : null,
                        latest ? latest.title : null,
                        meta,
                    ]
                        .filter(Boolean)
                        .join(', ')}
                >
                    <FlatCardSurface className="mb-3">
                        <VStack className="px-4 py-3" style={{ gap: 4 }}>
                            <HStack className="items-start" style={{ gap: 8 }}>
                                <View style={{ flex: 1, minWidth: 0 }}>
                                    <TranslatableDynamic
                                        text={title}
                                        numberOfLines={2}
                                        style={{ color: c.ink, fontSize: 17, lineHeight: 22, fontWeight: '600' }}
                                    />
                                </View>
                                {unseen > 0 ? (
                                    <View style={[styles.badge, { backgroundColor: c.surfaceRaised }]}>
                                        <Text style={{ color: c.accentText, fontSize: 12, lineHeight: 16, fontWeight: '700' }}>
                                            {t('trackedStories.updatesBadge', { count: unseen })}
                                        </Text>
                                    </View>
                                ) : null}
                                {item.status === 'ended' ? (
                                    <View style={[styles.badge, { backgroundColor: c.surface }]}>
                                        <Text style={{ color: c.ink3, fontSize: 12, lineHeight: 16, fontWeight: '600' }}>
                                            {t('trackedStories.endedLabel')}
                                        </Text>
                                    </View>
                                ) : null}
                            </HStack>
                            {latest ? (
                                // The snapshot's `title` is ENGLISH; the original
                                // is `titleOriginal` (absent on older snapshots).
                                <TranslatableDynamic
                                    text={latest.title}
                                    originalText={latest.titleOriginal}
                                    originalLanguage={latest.languageCode ?? null}
                                    numberOfLines={2}
                                    style={{ color: c.ink2, fontSize: 14, lineHeight: 19 }}
                                />
                            ) : null}
                            <Text numberOfLines={1} style={{ color: c.ink3, fontSize: 12, lineHeight: 17 }}>
                                {meta}
                            </Text>
                        </VStack>
                    </FlatCardSurface>
                </PressableCard>
            );
        },
        [t, c, openTimeline],
    );

    const keyExtractor = useCallback((item: TrackedStoryModel) => item.id, []);

    // EU AI Act Art. 50 transparency: one line under the rows. "All" only
    // when every title on screen is AI-written; a story followed seconds ago
    // still shows its own title while its headline is written.
    const llmCount = stories.filter((s) => !!s.llmHeadline).length;
    const aiNote =
        llmCount === 0
            ? null
            : llmCount === stories.length
              ? t('aiDisclosure.allStoryTitles')
              : t('aiDisclosure.listNote');

    return (
        <View style={{ flex: 1 }}>
            <Animated.FlatList
                testID="tracked-stories-list"
                data={stories}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                ListHeaderComponent={listHeader}
                ListEmptyComponent={
                    <ForYouEmptyState
                        animationId="following-what-it-is"
                        title={t('trackedStories.emptyTitle')}
                        body={t('trackedStories.emptyBodyMera')}
                        action={{
                            label: t('trackedStories.learnAbout'),
                            onPress: () => openTutorial('following'),
                            testID: 'tracked-stories-learn',
                        }}
                        testID="tracked-stories-empty"
                    />
                }
                ListFooterComponent={
                    aiNote ? (
                        <View style={{ alignItems: 'center', paddingTop: 4 }}>
                            <AiDisclosureCaption variant="compact" align="left" text={aiNote} />
                        </View>
                    ) : null
                }
                contentContainerStyle={{
                    paddingTop: headerHeight + 12,
                    // The same inset as the Feed's list, so the title row
                    // lines up with the rows under it.
                    paddingHorizontal: 12,
                    paddingBottom: listEndClearance,
                    flexGrow: 1,
                }}
                showsVerticalScrollIndicator={false}
                onScroll={scrollHandler ?? notifyScrollTick}
                onContentSizeChange={active ? notifyScrollTick : undefined}
                scrollEventThrottle={16}
            />

            <BottomSheet
                open={!!menuTarget}
                onClose={() => setMenuTarget(null)}
                // The confirm opens once the sheet has fully gone: iOS refuses a
                // second modal over one still leaving.
                onClosed={() => {
                    const picked = stopPicked.current;
                    stopPicked.current = null;
                    if (picked) setConfirmTarget(picked);
                }}
                testID="tracked-stories-menu"
            >
                <ActionSheetRow
                    testID="tracked-stories-stop"
                    label={t('trackedStories.stopFollowing')}
                    icon="remove-circle-outline"
                    destructive
                    onPress={() => {
                        stopPicked.current = menuTarget;
                        setMenuTarget(null);
                    }}
                />
            </BottomSheet>

            <ConfirmDialog
                open={!!confirmTarget}
                title={t('trackedStories.stopFollowingConfirmTitle')}
                body={t('trackedStories.stopFollowingConfirmBody')}
                confirmLabel={t('trackedStories.stopFollowing')}
                destructive
                onConfirm={handleConfirmUntrack}
                onCancel={() => setConfirmTarget(null)}
                testID="untrack-confirm"
            />
        </View>
    );
};

const styles = StyleSheet.create({
    badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, marginTop: 2 },
});

export default TrackedStoriesScreen;
