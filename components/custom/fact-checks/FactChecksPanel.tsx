import FactCheckCard from '@/components/custom/fact-checks/FactCheckCard';
import { Box } from '@/components/ui/box';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import PageTitleRow from '@/components/custom/nav/PageTitleRow';
import { openTutorial } from '@/components/custom/tutorials/open-tutorial';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import { hapticLight } from '@/lib/haptics';
import { useOpenArticle } from '@/lib/hooks/use-open-article';
import {
    useFactCheckItems,
    useFactChecksHydrated,
    useFactChecksRefreshing,
    useFactChecksStore,
    isUnseenDone,
} from '@/lib/stores/fact-checks-store';
import type { StoredFactCheck } from '@/lib/database/services/fact-check-record-service';
import { reconcileAskedFactChecks } from '@/lib/fact-check/fact-check-graphql-client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useColors } from '@/lib/theme/tokens';
import { ShieldCheck } from 'lucide-react-native';
import { RefreshControl, View } from 'react-native';
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { PAGE_CONTENT_GAP, PAGE_SIDE_INSET, PAGE_TITLE_GAP } from '@/components/custom/nav/page-registry';
import { usePageScrollTarget } from '@/components/custom/nav/page-scroll';



interface FactChecksPanelProps {
    /** True while this is the visible Library page. Drives the re-read on
     *  every arrival: the page stays mounted as a warmed neighbour, so without
     *  this the list would go stale after its first visit. */
    readonly active?: boolean;
    /** The tab's collapsing-header scroll handler. The list MUST be an
     *  `Animated.FlatList` for this to reach the UI thread: a worklet attached
     *  to a plain RN `FlatList` silently does nothing. */
    readonly scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
    /** Measured height of the tab's collapsing header, used as the list's
     *  content `paddingTop` so rows scroll UNDER it rather than the host padding
     *  a wrapper (which leaves a dead gap once the header translates away). */
    readonly headerHeight?: number;
    /** List-end padding (the host's clearance for the tab bar and the Mera
     *  button). Defaults to the tab-bar clearance plus a gap. */
    readonly listEndPadding?: number;
}

/**
 * Every fact check this device has asked for, newest first, with a per-row
 * delete: the Library's Checks page.
 *
 * This is the ONLY surface for the feature. There is no standalone route and no
 * "view all" hop: the page shows the whole list, the same way Saved and
 * Visited do.
 *
 * Rows come from the on-device `fact_checks` table, which the article panel
 * (and, pivot P8d, this panel itself) writes to.
 *
 * A fact check exists here only because the reader asked for it (there are no
 * automatic or community checks). Rows already stored stay as they are: the
 * list is the table, unfiltered.
 *
 * `reconcileAskedFactChecks()` runs FIRST, and is what makes the read
 * trustworthy for an asked check nobody is actively watching: a request lodged
 * via chat and then left (the reader closed the article, or the in-session
 * poller passed its ceiling) has no path back to this list without it, which
 * is exactly how a server-side COMPLETE check once kept showing "Still
 * searching" (r14 P2b). It re-reads only checks this device asked for that
 * have not settled, bounded, and costs nothing once everything is terminal.
 *
 * Delete is local-only and genuinely cheap: the server keeps its own cross-user
 * cache, so a deleted row can be re-fetched by opening the article and asking
 * again. Nothing here is user-authored content a delete could destroy.
 */
const FactChecksPanel: React.FC<FactChecksPanelProps> = ({
    active = true,
    scrollHandler,
    headerHeight = 0,
    listEndPadding,
}) => {
    const { t } = useTranslation();
    // The tab's re-tap scrolls this page to the top (nav/page-scroll).
    const listRef = useRef<Animated.FlatList<StoredFactCheck>>(null);
    usePageScrollTarget(listRef);
    const colors = useColors();
    // Inside a tab on iOS the inset already includes the tab bar; measured on
    // device, adding TAB_BAR_HEIGHT left ~2x the bar of dead space at the end.
    const tabClearance = useTabBarClearance();
    const items = useFactCheckItems();
    const hydrated = useFactChecksHydrated();
    const refreshing = useFactChecksRefreshing();
    const refresh = useFactChecksStore((s) => s.refresh);
    const load = useFactChecksStore((s) => s.load);
    const remove = useFactChecksStore((s) => s.remove);
    const markSeen = useFactChecksStore((s) => s.markSeen);

    // "New" on this visit: finished after the page was last seen. Snapshot
    // the seen time BEFORE marking, so the pills stay for the whole visit while
    // the dots clear at once.
    const [seenBefore, setSeenBefore] = useState<number | null>(null);
    useEffect(() => {
        if (!active) return;
        setSeenBefore(useFactChecksStore.getState().seenAt);
        markSeen();
    }, [active, markSeen]);

    // The reconcile-then-refresh sequence, shared by the activation effect
    // below and the pull-to-refresh control: sweep BEFORE reading, awaited, so
    // a row the sweep advances to terminal is already in the table by the time
    // `refresh()` reads it — reading first would show the stale row and need a
    // SECOND trigger to notice the sweep's own write.
    const reconcileAndRefresh = useCallback(async () => {
        await reconcileAskedFactChecks();
        await refresh();
    }, [refresh]);

    // Re-read whenever the page becomes active: it stays mounted as a
    // neighbour in the tab's swipe window, so a mount-only effect
    // would show a frozen list on every later visit. Bounded: terminal rows are
    // skipped, so a settled table costs no requests. SILENT (`load`, not
    // `refresh`): arriving must not flash the pull-to-refresh spinner.
    useEffect(() => {
        if (!active) return;
        void (async () => {
            await reconcileAskedFactChecks();
            await load();
        })();
    }, [active, load]);

    // Warmed off-screen before anything has read the table: one local read (no
    // network, no spinner), so the rows are already drawn when the reader
    // swipes in.
    useEffect(() => {
        if (!active && !hydrated) void load();
        // Once per mount: `hydrated` flips true after this read.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleDelete = useCallback((id: string) => {
        void hapticLight();
        void remove(id);
    }, [remove]);

    // Opening a card goes through the SHARED article-open handler, not a bare
    // `router.push`: it resolves the article to a local suggestion when one
    // exists and routes to suggestion-detail (which shows Mera's reason) rather
    // than the bare article view. Both destinations mount `FactCheckPanel`,
    // which is a pure observer of the stored rows — so the check renders there
    // regardless of which of the two screens the tap landed on.
    const openArticle = useOpenArticle();
    const handleOpen = useCallback((item: StoredFactCheck) => {
        if (!item.articleId) return;
        openArticle({ articleId: item.articleId });
    }, [openArticle]);

    const renderItem = useCallback(
        ({ item }: { item: StoredFactCheck }) => (
            <Box className="mb-3">
                <FactCheckCard
                    item={item}
                    isNew={isUnseenDone(item, seenBefore)}
                    onPress={handleOpen}
                    onDelete={handleDelete}
                    testIDPrefix="fact-check-list"
                />
            </Box>
        ),
        [handleDelete, handleOpen, seenBefore],
    );

    return (
        <Box className="flex-1" testID="fact-checks-panel">
            <Animated.FlatList
                ref={listRef}
                data={items}
                keyExtractor={(item: StoredFactCheck) => item.id}
                renderItem={renderItem as any}
                testID="fact-checks-list"
                // The count says more than the pill; the bare name would only repeat it.
                ListHeaderComponent={
                    items.length > 0 ? (
                        <View style={{ marginBottom: PAGE_TITLE_GAP }}>
                            <PageTitleRow title={t('library.checks.count', { count: items.length })} testID="fact-checks-title-row" />
                        </View>
                    ) : null
                }
                // The manual path: a reader who suspects the list is stale can
                // always ask directly rather than waiting for the next arrival.
                // Same reconcile-then-refresh sequence as above, so a pull can
                // also advance a check the activation sweep has not reached.
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={() => { void reconcileAndRefresh(); }}
                        tintColor={colors.accent}
                        colors={[colors.accent]}
                        // Push the spinner below the absolute collapsing header
                        // so it isn't hidden behind it (Android). Same as every
                        // other Library page.
                        progressViewOffset={headerHeight}
                    />
                }
                contentContainerStyle={{
                    paddingTop: headerHeight + PAGE_CONTENT_GAP,
                    paddingHorizontal: PAGE_SIDE_INSET,
                    // Clear of the tab bar and the Mera button.
                    paddingBottom: listEndPadding ?? tabClearance + 24,
                }}
                showsVerticalScrollIndicator={false}
                // Embedded, the collapsible header's handler ticks; standalone,
                // tick directly. At rest, a content change re-measures.
                onScroll={scrollHandler ?? notifyScrollTick}
                // Only the active panel feeds the translation scheduler.
                onContentSizeChange={active ? notifyScrollTick : undefined}
                scrollEventThrottle={16}
                ListEmptyComponent={
                    // Only once a read has completed, or the empty state
                    // flashes for a frame on every open before the rows land.
                    // Names the two ways a reader asks for a check.
                    hydrated ? (
                        <ForYouEmptyState
                            // FinalLibrary #4: an outlined shield with a check.
                            glyph={<ShieldCheck size={48} color={colors.ink2} strokeWidth={1.75} />}
                            title={t('library.checks.emptyTitle')}
                            body={t('library.checks.emptyBodyMenu')}
                            action={{
                                label: t('library.checks.learn'),
                                onPress: () => openTutorial('library', 'fact-checks'),
                                testID: 'fact-checks-learn',
                            }}
                            testID="fact-checks-empty"
                        />
                    ) : null
                }
            />
        </Box>
    );
};

export default FactChecksPanel;
