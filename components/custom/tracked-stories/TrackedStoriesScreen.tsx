import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import AiDisclosureCaption from '@/components/custom/AiDisclosureCaption';
import FreeTierInlineNotice from '@/components/custom/subscription/FreeTierInlineNotice';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import {
    Modal,
    ModalBackdrop,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
} from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
    MAX_MEMBER_IDS,
    observeActive,
} from '@/lib/database/services/tracked-story-service';
import { deleteTrackedStoryById } from '@/lib/tracking/track-actions';
import { startFollowStoryChat } from '@/lib/tracking/follow-story-chat';
import type TrackedStoryModel from '@/lib/database/models/TrackedStory';
import { hapticLight } from '@/lib/haptics';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { useAiAccess } from '@/lib/stores/subscription-store';
import { formatTimeAgo } from '@/lib/utils/time-ago';
import { MaterialIcons } from '@expo/vector-icons';
import { Crosshair } from 'lucide-react-native';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListRenderItem } from 'react-native';
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface TrackedStoriesScreenProps {
    /** Embedded inside the For-You "Stories" sub-tab — hides the back button and
     *  tightens the header (the host owns the top chrome). Route usage omits it. */
    embedded?: boolean;
    /** Back handler for the non-embedded (route/deep-link) variant. */
    onBack?: () => void;
    /** The host's collapsing-header scroll handler (Dashboard sub-tab use). The
     *  list MUST be an `Animated.FlatList` for this to do anything — a
     *  `useAnimatedScrollHandler` worklet attached to a plain RN `FlatList` never
     *  reaches the UI thread, which is why this panel's header stayed pinned
     *  while Overview's collapsed. Omitted on the standalone route. */
    scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
    /** Measured height of the host's collapsing header. Becomes the list's
     *  content `paddingTop` so the rows scroll UNDER the header instead of the
     *  host padding a wrapper View (which would leave a dead gap once the header
     *  translates away). Defaults to 0 — standalone route is unchanged. */
    headerHeight?: number;
}

/**
 * The "Followed stories" list — every active tracked story, live via
 * `observeActive` (unseen-first, newest-next). Each row shows the LLM headline
 * (falling back to the tracked title), the latest development snippet, an unseen
 * badge, a relative timestamp, and — for auto-ended stories — an "Ended" pill.
 * Tapping opens the story timeline; long-press or the trash icon confirms
 * untracking. Rendered both embedded (For-You sub-tab) and as a standalone route.
 */
const TrackedStoriesScreen: React.FC<TrackedStoriesScreenProps> = ({
    embedded = false,
    onBack,
    scrollHandler,
    headerHeight = 0,
}) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const [stories, setStories] = useState<TrackedStoryModel[]>([]);
    const [confirmTarget, setConfirmTarget] = useState<TrackedStoryModel | null>(null);
    // 'unknown' (cold start, no server/RC answer yet) must NOT read as locked —
    // this screen stays fully functional either way, so the only thing this
    // gates is which empty-state copy renders below.
    const locked = useAiAccess() === 'locked';

    useEffect(() => {
        const sub = observeActive().subscribe({
            next: (rows) => setStories(rows),
            error: () => setStories([]),
        });
        return () => sub.unsubscribe();
    }, []);

    const openTimeline = useCallback((story: TrackedStoryModel) => {
        router.push({
            pathname: '/logged-in/story-timeline',
            params: { trackedStoryId: story.id },
        });
    }, []);

    const handleConfirmUntrack = useCallback(async () => {
        if (!confirmTarget) return;
        const id = confirmTarget.id;
        setConfirmTarget(null);
        // deleteTrackedStoryById, not untrackStory: the latter drops the row but
        // leaves the linked TOPIC active, so the story's coverage kept being
        // fetched after the user deleted it.
        await deleteTrackedStoryById(id);
        // The observeActive subscription drops the row automatically.
    }, [confirmTarget]);

    const renderItem: ListRenderItem<TrackedStoryModel> = useCallback(
        ({ item }) => {
            const headline = item.llmHeadline ?? item.fallbackTitle;
            // EU AI Act Art. 50 transparency (Group C1) — true only when the
            // displayed headline is actually the LLM-generated one; the
            // `fallbackTitle` path (no `llmHeadline` yet) has no AI text to
            // disclose.
            //
            // The VISIBLE per-row caption this used to gate is gone: repeated
            // under every row it was noise, so the disclosure moved to a single
            // list-level note (see `listNote` below). This flag still gates the
            // AUDIBLE half — see the accessibilityLabel.
            const isLlmHeadline = !!item.llmHeadline;
            const latest = item.latestTitle;
            const showLatest = !!latest && latest.trim().length > 0 && latest !== headline;
            const unseen = item.unseenCount ?? 0;
            // Total coverage gathered under this story. `memberArticleIds` is
            // capped at MAX_MEMBER_IDS, so at the cap the true total is
            // unknowable from the row — render "30+" rather than a confidently
            // wrong exact number.
            const total = (item.memberArticleIds ?? []).length;
            const totalLabel =
                total >= MAX_MEMBER_IDS
                    ? t('trackedStories.articleCountCapped', { count: MAX_MEMBER_IDS })
                    : t('trackedStories.articleCount', { count: total });
            const relative = formatTimeAgo(t, item.lastUpdateAt ?? item.createdAt);
            return (
                <Pressable
                    onPress={() => openTimeline(item)}
                    onLongPress={() => {
                        hapticLight();
                        setConfirmTarget(item);
                    }}
                    accessibilityRole="button"
                    // The card renders four things; a label of just the headline
                    // dropped the rest for a screen-reader user. Order mirrors
                    // the visual order: title, unseen badge, total, age.
                    //
                    // The disclosure rides here too, right after the headline it
                    // qualifies. It is deliberately NOT visible — sighted users
                    // get the list-level note above row 1, but a screen-reader
                    // user who lands mid-list (rotor, restored scroll position,
                    // returning from a story) never passes that header and would
                    // otherwise get no signal at all that the headline is
                    // machine-generated. Costs nothing visually; restores exactly
                    // what removing the per-row caption took away.
                    accessibilityLabel={[
                        headline,
                        isLlmHeadline ? t('aiDisclosure.short') : null,
                        unseen > 0 ? t('trackedStories.updatesBadge', { count: unseen }) : null,
                        total > 0 ? totalLabel : null,
                        relative || null,
                    ]
                        .filter(Boolean)
                        .join(', ')}
                    className="mx-4 mb-3 rounded-2xl border border-gray-800 bg-gray-900 px-4 py-3"
                >
                    <HStack className="items-start" space="sm">
                        <VStack className="flex-1 min-w-0" space="xs">
                            <HStack className="items-center flex-wrap" space="xs">
                                {unseen > 0 && (
                                    <Box className="rounded-full bg-primary-400 px-2 py-0.5">
                                        <Text size="2xs" className="text-black font-bold">
                                            {t('trackedStories.updatesBadge', { count: unseen })}
                                        </Text>
                                    </Box>
                                )}
                                {item.status === 'ended' && (
                                    <Box className="rounded-full bg-gray-700 px-2 py-0.5">
                                        <Text size="2xs" className="text-gray-300 font-semibold">
                                            {t('trackedStories.endedLabel')}
                                        </Text>
                                    </Box>
                                )}
                            </HStack>
                            <TranslatableDynamic
                                text={headline}
                                as="heading"
                                size="md"
                                numberOfLines={2}
                                className="text-white"
                            />
                            {showLatest && (
                                <TranslatableDynamic
                                    text={latest as string}
                                    size="xs"
                                    numberOfLines={1}
                                    className="text-typography-400"
                                />
                            )}
                            {/* Meta line: total coverage + last-activity age,
                                in the card's existing 2xs muted style. */}
                            <HStack className="items-center mt-0.5" space="xs">
                                {total > 0 && (
                                    <Text size="2xs" className="text-typography-500">
                                        {totalLabel}
                                    </Text>
                                )}
                                {total > 0 && !!relative && (
                                    <Text size="2xs" className="text-typography-600">
                                        ·
                                    </Text>
                                )}
                                {!!relative && (
                                    <Text size="2xs" className="text-typography-500">
                                        {relative}
                                    </Text>
                                )}
                            </HStack>
                        </VStack>
                        <Pressable
                            onPress={() => setConfirmTarget(item)}
                            hitSlop={10}
                            accessibilityRole="button"
                            accessibilityLabel={t('trackedStories.untrackAction')}
                            className="p-1"
                        >
                            <MaterialIcons name="delete-outline" size={20} color="#9CA3AF" />
                        </Pressable>
                    </HStack>
                </Pressable>
            );
        },
        [t, openTimeline],
    );

    const keyExtractor = useCallback((item: TrackedStoryModel) => item.id, []);

    // EU AI Act Art. 50 transparency (Group C1), lifted from the rows to the
    // list. One note instead of N identical captions.
    //
    // The gate is load-bearing, not belt-and-braces: RN renders
    // `ListHeaderComponent` even when `data` is empty (alongside
    // `ListEmptyComponent`), so without it an empty followed-stories list would
    // carry a disclosure about headlines that aren't there. It also handles the
    // all-`fallbackTitle` case, where nothing on screen is AI-written yet.
    //
    // Copy is hedged ("Some story headlines here…") because the list can be
    // MIXED — a story tracked seconds ago still shows its `fallbackTitle` while
    // the generated headline is in flight. An unhedged note would be false about
    // those rows.
    const anyLlmHeadline = stories.some((s) => !!s.llmHeadline);
    const ListHeader = anyLlmHeadline ? (
        // Inside the FlatList (not the title block above it) so it scrolls with
        // the rows it describes, and so it precedes row 1 in the accessibility
        // reading order.
        <Box className="px-5 pb-2">
            <AiDisclosureCaption
                variant="compact"
                align="left"
                text={t('aiDisclosure.listNote')}
            />
        </Box>
    ) : null;

    // The FAB (and the empty state's CTA) both start the same conversation:
    // Mera opens on the follow-story context with the seed turn already sent,
    // asks what to follow, and stages the scope card the user taps to confirm.
    // The whole behaviour lives in lib/ — this is just the tap.
    const startFollowStory = useCallback(() => {
        startFollowStoryChat(t('trackedStories.followChatSeed'));
    }, [t]);

    const ListEmpty = (
        <Box className="flex-1 items-center justify-center px-8 py-20">
            <MaterialIcons name="auto-awesome" size={48} color="#6B7280" />
            <Text size="lg" className="text-white text-center font-semibold mt-4">
                {t('trackedStories.emptyTitle')}
            </Text>
            <Text size="sm" className="text-typography-400 text-center mt-2">
                {/* Monetization wave: the default body sends the user to go
                    track a story, which fails while locked — starting a NEW
                    story needs an active plan. The free-tier copy explains that
                    instead. Stories already tracked are unaffected; this is
                    purely the zero-state message. */}
                {locked ? t('freeTier.trackedStoriesEmptyBody') : t('trackedStories.emptyBody')}
            </Text>
            {/* The hint + CTA used to walk the user to the article DETAIL
                screen's crosshair, because that was the only place a track could
                START. It isn't any more: the FAB below starts one from here, so
                sending them to the Feed to find an article would be the long way
                round to a thing this screen now does itself. Same handler as the
                FAB — one entry point, two affordances.

                Locked: both exist only to walk the user through STARTING a new
                track, which the free-tier body above just said needs a plan —
                showing them would repeat a broken instruction. Suppressed rather
                than relabeled; `FreeTierCard`/`FreeTierInlineNotice` already own
                "See plans" messaging elsewhere and this empty state isn't the
                place to duplicate it. (The FAB self-gates the same way.) */}
            {!locked && (
                <>
                    <Text size="xs" className="text-typography-500 text-center mt-4">
                        {t('trackedStories.emptyHintFollow')}
                    </Text>
                    <Button
                        variant="outline"
                        className="rounded-full border-primary-500 mt-4"
                        onPress={startFollowStory}
                        testID="tracked-stories-empty-cta"
                    >
                        <ButtonText className="text-primary-400">
                            {t('trackedStories.emptyCtaFollow')}
                        </ButtonText>
                    </Button>
                </>
            )}
        </Box>
    );

    return (
        // No `bg-black`: embedded, this sits inside ForYouScreen and a flat fill
        // here would punch a hole in that page's backdrop; standalone, the
        // backdrop below is the page background.
        <Box className="flex-1">
            {/* Page background — only when standalone. Embedded, the host page
                already mounts one and a second would stack two animated fields. */}
            {!embedded && <AbstractGradientBackdrop />}

            {!embedded && (
                <Box style={{ position: 'absolute', left: 8, top: insets.top + 8, zIndex: 20 }}>
                    <Pressable
                        onPress={onBack}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.cancel')}
                        className="bg-gray-900 rounded-full p-3 shadow-hard-2"
                    >
                        <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                    </Pressable>
                </Box>
            )}

            {/* The title moved INSIDE the list (below) so it scrolls away with
                the rows under the host's collapsing header. Left as a sibling it
                would sit pinned beneath an absolute header — jammed under the
                status bar once the header hid, and eating the space the collapse
                is supposed to reclaim. The 12px spacer reproduces the
                `paddingTop: 12` this list used to carry, so the standalone route
                (headerHeight 0) keeps its exact sequence: title, 12px, banner,
                rows. */}
            <Animated.FlatList
                testID="tracked-stories-list"
                data={stories}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                ListHeaderComponent={
                    <>
                        <VStack
                            className="px-5 pb-2"
                            style={{ paddingTop: embedded ? 8 : insets.top + 16 }}
                        >
                            <Heading
                                size="3xl"
                                className={embedded ? 'text-white' : 'text-white ml-14'}
                            >
                                {t('trackedStories.title')}
                            </Heading>
                        </VStack>
                        <Box style={{ height: 12 }} />
                        {/* Mera News Free: the one sentence that explains why
                            the track affordances elsewhere are refusing. It
                            self-gates on `useAiAccess()` and renders null
                            unless locked, so entitlement is deliberately NOT
                            re-checked here — a second copy of that gate could
                            only drift.
                            `stories.length` is a different axis and does need
                            a gate, for the same reason `anyLlmHeadline` above
                            has one: RN renders `ListHeaderComponent` even when
                            `data` is empty, alongside `ListEmptyComponent`. Un-
                            gated, a locked user with nothing followed would get
                            "the stories you already follow keep everything
                            they've collected" — false about an empty list —
                            stacked on top of the locked empty body that already
                            says this better.
                            The `px-5` wrapper matches the title and
                            `ListHeader`; the notice carries only internal
                            padding and would otherwise sit edge-to-edge. */}
                        {stories.length > 0 && (
                            <Box className="px-5 pb-2">
                                <FreeTierInlineNotice surface="stories-header" />
                            </Box>
                        )}
                        {ListHeader}
                    </>
                }
                ListEmptyComponent={ListEmpty}
                contentContainerStyle={{
                    paddingTop: headerHeight,
                    paddingBottom: insets.bottom + 40,
                    // Retained: this is what lets ListEmpty's `flex-1` fill and
                    // centre. Do not drop it when touching the padding above.
                    flexGrow: 1,
                }}
                showsVerticalScrollIndicator={false}
                onScroll={scrollHandler}
                scrollEventThrottle={16}
            />

            {/* Start-a-follow FAB — bottom right, carrying the same crosshair
                the card/detail track buttons use (CardActionBar), so the
                affordance reads as "follow" rather than as a generic "+".

                Hidden while locked, deliberately and on the same axis as the
                empty-state CTA above: `openArticleFeedback` silently no-ops for
                a free-tier user, so a visible FAB here would be a button that
                does nothing at all.

                Bottom offset clears the native tab bar when this screen is
                EMBEDDED in the Dashboard's Stories sub-tab; standalone (its own
                route, no tab shell) it only clears the home indicator. Same
                convention as ScrollToTopFab's `extraBottomOffset`. */}
            {!locked && (
                <Pressable
                    testID="tracked-stories-track-fab"
                    onPress={startFollowStory}
                    accessibilityRole="button"
                    accessibilityLabel={t('trackedStories.followFabLabel')}
                    className="absolute right-5 h-14 w-14 items-center justify-center rounded-full bg-primary-500 shadow-hard-3"
                    style={{ bottom: 20 + insets.bottom + (embedded ? TAB_BAR_HEIGHT : 0) }}
                >
                    <Crosshair size={26} strokeWidth={2} color="#000000" fill="none" />
                </Pressable>
            )}

            <Modal isOpen={!!confirmTarget} onClose={() => setConfirmTarget(null)}>
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader>
                        <Heading size="md" className="text-white">
                            {t('trackedStories.untrackConfirmTitle')}
                        </Heading>
                    </ModalHeader>
                    <ModalBody>
                        <Text size="sm" className="text-typography-300">
                            {t('trackedStories.untrackConfirmBody')}
                        </Text>
                    </ModalBody>
                    <ModalFooter>
                        <Button
                            variant="outline"
                            action="secondary"
                            onPress={() => setConfirmTarget(null)}
                            className="mr-3"
                        >
                            <ButtonText>{t('common.cancel')}</ButtonText>
                        </Button>
                        {/* Distinct copy from the trash icon that opens this
                            dialog. Both used to read "Untrack story", so a
                            screen-reader user heard two identically-named
                            buttons and could not tell the trigger from the
                            confirmation. The icon stays "Untrack story"; this
                            one names the ACTION it commits. */}
                        <Button
                            action="negative"
                            onPress={handleConfirmUntrack}
                            testID="untrack-confirm"
                            accessibilityLabel={t('trackedStories.untrackConfirmCta')}
                        >
                            <ButtonText>{t('trackedStories.untrackConfirmCta')}</ButtonText>
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>
        </Box>
    );
};

export default TrackedStoriesScreen;
