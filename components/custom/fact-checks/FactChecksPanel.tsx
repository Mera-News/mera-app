import FactCheckCard from '@/components/custom/fact-checks/FactCheckCard';
import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { hapticLight } from '@/lib/haptics';
import { useOpenArticle } from '@/lib/hooks/use-open-article';
import {
    useFactCheckItems,
    useFactChecksHydrated,
    useFactChecksRefreshing,
    useFactChecksStore,
} from '@/lib/stores/fact-checks-store';
import type { StoredFactCheck } from '@/lib/database/services/fact-check-record-service';
import { reconcileStoredFactChecks } from '@/lib/fact-check/fact-check-graphql-client';
import React, { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshControl } from 'react-native';
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const REFRESH_TINT = '#EDA77E';

interface FactChecksPanelProps {
    /** True while this is the selected Dashboard chip. Drives the re-read on
     *  every (re)selection — the chip is mounted once and then only hidden, so
     *  without this the list would go stale after its first visit. */
    readonly active?: boolean;
    /** The Dashboard's collapsing-header scroll handler. The list MUST be an
     *  `Animated.FlatList` for this to reach the UI thread — a worklet attached
     *  to a plain RN `FlatList` silently does nothing, which is what left other
     *  sub-tab panels' headers pinned. */
    readonly scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
    /** Measured height of the Dashboard's collapsing header, used as the list's
     *  content `paddingTop` so rows scroll UNDER it rather than the host padding
     *  a wrapper (which leaves a dead gap once the header translates away). */
    readonly headerHeight?: number;
}

/**
 * Every fact check this device has asked for, newest first, with a per-row
 * delete — rendered inline as the Dashboard's "Fact checks" chip.
 *
 * This is the ONLY surface for the feature. There is no standalone route and no
 * "view all" hop: selecting the chip shows the whole list right here, the same
 * way Saved and History do.
 *
 * Rows come from the on-device `fact_checks` table, which the article panel
 * (and, pivot P8d, this panel itself) writes to. `refresh` (not `load`) is
 * what runs on mount and on every chip selection.
 *
 * `reconcileStoredFactChecks()` runs FIRST, and is what makes `refresh()`
 * trustworthy for a row nobody is actively watching: `useFactCheck`'s poll
 * only ever covers the ONE article open at a time, so a request lodged via
 * chat and then left — the reader closed the article, or the poll itself gave
 * up at its ceiling (`POLL_CEILING_MS`) — has no path back to this list
 * without it. Without this call, a local-only read renders whatever the table
 * happens to hold, which is exactly how a server-side COMPLETE check kept
 * showing "Still searching" indefinitely once already (r14 P2b, "a completed
 * check was stuck forever" — the bug this file's own copy now promises won't
 * happen: `factCheck.queuedHint` and `factCheck.stillChecking` both tell the
 * reader to look here). It costs one bounded server read per UNRESOLVED row
 * (capped, see `RECONCILE_CAP`) and zero once everything is terminal — there
 * is no poll, no interval, just a bounded sweep.
 *
 * Delete is local-only and genuinely cheap: the server keeps its own cross-user
 * cache, so a deleted row can be re-fetched by opening the article and asking
 * again. Nothing here is user-authored content a delete could destroy.
 */
const FactChecksPanel: React.FC<FactChecksPanelProps> = ({
    active = true,
    scrollHandler,
    headerHeight = 0,
}) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const items = useFactCheckItems();
    const hydrated = useFactChecksHydrated();
    const refreshing = useFactChecksRefreshing();
    const refresh = useFactChecksStore((s) => s.refresh);
    const remove = useFactChecksStore((s) => s.remove);

    // The reconcile-then-refresh sequence, shared by the activation effect
    // below and the pull-to-refresh control: sweep BEFORE reading, awaited, so
    // a row the sweep advances to terminal is already in the table by the time
    // `refresh()` reads it — reading first would show the stale row and need a
    // SECOND trigger to notice the sweep's own write.
    const reconcileAndRefresh = useCallback(async () => {
        await reconcileStoredFactChecks();
        await refresh();
    }, [refresh]);

    // Re-read whenever the chip becomes active. The panel stays mounted behind
    // `display: 'none'` once visited, so a mount-only effect would fire exactly
    // once per app launch and every later visit would show a frozen list.
    // Bounded: terminal rows are skipped, so a settled table costs no requests.
    useEffect(() => {
        if (!active) return;
        void reconcileAndRefresh();
    }, [active, reconcileAndRefresh]);

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
                    onPress={handleOpen}
                    onDelete={handleDelete}
                    testIDPrefix="fact-check-list"
                />
            </Box>
        ),
        [handleDelete, handleOpen],
    );

    return (
        <Box className="flex-1" testID="fact-checks-panel">
            <Animated.FlatList
                data={items}
                keyExtractor={(item: StoredFactCheck) => item.id}
                renderItem={renderItem as any}
                testID="fact-checks-list"
                ListHeaderComponent={
                    <VStack className="pb-2 mb-1" style={{ paddingTop: 8 }}>
                        <Heading size="4xl" className="text-white">
                            {t('factCheck.dashboard.listTitle')}
                        </Heading>
                        <Text size="sm" className="text-typography-400 mt-1">
                            {t('factCheck.dashboard.listSubtitle')}
                        </Text>
                    </VStack>
                }
                // The manual path — a user who suspects the list is stale can
                // always ask directly rather than waiting for the next chip
                // selection. Same reconcile-then-refresh sequence as above, so
                // a pull here can ALSO advance a row the activation sweep
                // hasn't gotten to yet (e.g. the panel has been sitting active
                // since before a request was even lodged).
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={() => { void reconcileAndRefresh(); }}
                        tintColor={REFRESH_TINT}
                        colors={[REFRESH_TINT]}
                        // Push the spinner below the absolute collapsing header
                        // so it isn't hidden behind it (Android). Same as every
                        // other Dashboard panel.
                        progressViewOffset={headerHeight}
                    />
                }
                contentContainerStyle={{
                    paddingTop: headerHeight,
                    paddingHorizontal: 16,
                    // Rendered INSIDE the floating tab navigator, so it needs the
                    // same tab-bar clearance as the other Dashboard panels.
                    paddingBottom: insets.bottom + TAB_BAR_HEIGHT + 24,
                }}
                showsVerticalScrollIndicator={false}
                onScroll={scrollHandler}
                scrollEventThrottle={16}
                ListEmptyComponent={
                    // Only once a read has completed — otherwise the empty state
                    // flashes for a frame on every open before the rows land.
                    hydrated ? (
                        <Text
                            size="sm"
                            className="text-typography-400 text-center mt-10"
                            testID="fact-checks-empty"
                        >
                            {t('factCheck.dashboard.empty')}
                        </Text>
                    ) : null
                }
            />
        </Box>
    );
};

export default FactChecksPanel;
