// The tab shell: the page strip header, one collapsing header shared by the
// tab's pages, the page swipe (PagePager) with its swipe into the next tab,
// the one explainer sheet behind every page title's ?, and World's Arrange
// overlay. Content lanes render it from their page-set
// component (FeedPages, WorldPages, LibraryPages, YouPages) and draw only
// their pages.
//
//  - The active page is tracked by ID, so a reorder, or World adding or
//    removing a country, never moves the reader. If the active page goes
//    away (its country removed), its left neighbour takes over.
//  - A page is `active` only while it is the visible page AND this screen is
//    focused (tab focused, nothing pushed over it in the tab's stack).
//  - Page requests arrive through navigate-to-page's one-shot pending store:
//    `navigateToPage` (shortcuts, redirect stubs, deep links)
//    and the cross-tab swipe's edge landing. Both are taken on focus, or at
//    once while focused. A plain tap on the tab keeps the page it was on.
//  - The surface is reported for the Mera button and the jump-origin Back.
//  - One collapsing header for all pages, as the Dashboard had: a page change
//    reveals it and resets its scroll origin (pages keep their own offsets).

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { useColors } from '@/lib/theme/tokens';
import { hapticSelection } from '@/lib/haptics';
import { useCollapsibleHeader } from '@/lib/hooks/use-collapsible-header';
import { useIsFocused } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import ArrangeOverlay from './ArrangeOverlay';
import {
  clearHeaderBottom,
  clearSurface,
  headerBottomInWindow,
  reportHeaderBottom,
  reportSurface,
} from './current-surface';
import {
  consumePendingEdge,
  consumePendingPage,
  navigateToTabEdge,
  usePendingEdge,
  usePendingPageRequest,
} from './navigate-to-page';
import PageExplainerSheet from './PageExplainerSheet';
import PagePager from './PagePager';
import { survivingPage } from './tab-swipe';
import PageStrip, { HEADER_BOTTOM_PAD, HEADER_SIDE_PAD, HEADER_TOP_PAD } from './PageStrip';
import { pageMeta, TAB_LABEL_KEYS, TAB_ORDER, type PageId } from './page-registry';
import { tabSwipeProgress } from './swipe-progress';
import type { PageHeaderBinding, TabPagesProps } from './types';

export type { TabPagesProps } from './types';

const ARRIVAL_FADE_MS = 150;

const TabPages: React.FC<TabPagesProps> = ({ tab, pages, renderPage, onSearch, arrange, leading, testID }) => {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const reduceMotion = useReducedMotion();
  const { scrollHandler, headerStyle, onHeaderLayout, headerHeight, reveal, resetScrollOrigin, hidden } =
    useCollapsibleHeader();

  const ids = useMemo(() => pages.map((p) => p.id), [pages]);
  const [chosenId, setChosenId] = useState<PageId | null>(null);
  const lastIndexRef = useRef(0);
  const activeId = survivingPage(ids, chosenId ?? ids[0] ?? null, lastIndexRef.current);
  const index = activeId ? Math.max(0, ids.indexOf(activeId)) : 0;
  lastIndexRef.current = index;
  // World's overlay: open, with the long-pressed page lifted.
  const [arrangeLift, setArrangeLift] = useState<PageId | null>(null);
  const arranging = arrangeLift !== null;
  // The ? beside a page title: ONE sheet per tab (not one per warm panel),
  // closed whenever the tab loses focus (a sheet survives a tab switch).
  const [explaining, setExplaining] = useState(false);
  const openExplainer = useCallback(() => setExplaining(true), []);

  const select = useCallback(
    (id: PageId) => {
      setChosenId(id);
      reveal();
      resetScrollOrigin();
    },
    [reveal, resetScrollOrigin],
  );

  // The reader moved to another page (pill tap or swipe): a selection tick.
  // Requests from elsewhere land silently.
  const pick = useCallback(
    (id: PageId) => {
      if (id !== activeId) void hapticSelection();
      select(id);
    },
    [activeId, select],
  );

  // ── Requests from elsewhere: a page, or a cross-tab edge ──
  const opacity = useSharedValue(1);
  const fadeIn = useCallback(() => {
    if (reduceMotion) return;
    opacity.value = 0;
    opacity.value = withTiming(1, { duration: ARRIVAL_FADE_MS });
  }, [reduceMotion, opacity]);
  const request = usePendingPageRequest();
  const edge = usePendingEdge();
  useEffect(() => {
    if (!focused || ids.length === 0) return;
    const landing = consumePendingEdge(tab);
    if (landing) {
      select(landing === 'first' ? ids[0] : ids[ids.length - 1]);
      fadeIn();
    }
    const req = consumePendingPage(tab);
    if (req && ids.includes(req.page)) select(req.page);
  }, [focused, request, edge, ids, tab, select, fadeIn]);

  // ── Surface for the Mera button and the jump-origin Back ──
  useEffect(() => {
    if (!focused || !activeId) return undefined;
    reportSurface(activeId);
    return () => clearSurface(activeId);
  }, [focused, activeId]);

  // ── Header bottom, for the Mera button's top corners (outside this tree) ──
  // The EXPANDED header's bottom edge in WINDOW coordinates, whatever the
  // collapse state: the Mera button never moves during a scroll (owner). The
  // header is absolute at this view's top and includes the status bar inset,
  // so its bottom is this view's window y plus the header's measured height.
  // The root is measured, never the header, which translates when collapsed.
  const rootRef = useRef<View>(null);
  const [rootY, setRootY] = useState<number | null>(null);
  const measureRoot = useCallback(() => {
    rootRef.current?.measureInWindow((_x, y) => {
      if (Number.isFinite(y)) setRootY((prev) => (prev === y ? prev : y));
    });
  }, []);
  useEffect(() => {
    if (focused) measureRoot();
  }, [focused, measureRoot]);
  useEffect(() => {
    if (!focused || headerHeight <= 0 || rootY === null) return;
    reportHeaderBottom(`tab:${tab}`, headerBottomInWindow(rootY, headerHeight));
  }, [focused, headerHeight, rootY, tab]);
  // Cleared only on blur or unmount, so a re-report never flickers through null.
  useEffect(() => {
    if (!focused) return undefined;
    return () => clearHeaderBottom(`tab:${tab}`);
  }, [focused, tab]);

  // ── Neighbouring tabs for the edge labels ──
  const tabIndex = TAB_ORDER.indexOf(tab);
  const prevTab = TAB_ORDER[tabIndex - 1];
  const nextTab = TAB_ORDER[tabIndex + 1];
  const onTabStep = useCallback(
    (step: 1 | -1) => {
      const target = step === 1 ? nextTab : prevTab;
      if (target) navigateToTabEdge(target, step === 1 ? 'first' : 'last');
    },
    [nextTab, prevTab],
  );

  const coverStyle = useAnimatedStyle(() => ({ opacity: hidden.value }));

  const header: PageHeaderBinding = useMemo(
    () => ({ scrollHandler, headerHeight, hidden, reveal, openExplainer }),
    [scrollHandler, headerHeight, hidden, reveal, openExplainer],
  );
  // Only the VISIBLE page drives the header. The warm neighbours share the
  // pager window and would otherwise feed it their own offsets: a neighbour's
  // event at y = 0 reads as "at the top" and reveals the header under a list
  // scrolled hundreds of points down.
  const idleScroll = useAnimatedScrollHandler({ onScroll: () => {} });
  const idleHeader: PageHeaderBinding = useMemo(
    () => ({ ...header, scrollHandler: idleScroll }),
    [header, idleScroll],
  );
  useEffect(() => {
    if (!focused) setExplaining(false);
  }, [focused]);
  const keep = useMemo(
    () => ids.map((id, i) => (pageMeta(id).keepMounted ? i : -1)).filter((i) => i >= 0),
    [ids],
  );
  const renderPanel = useCallback(
    (i: number, pageActive: boolean) =>
      renderPage({
        pageId: ids[i],
        active: pageActive && focused && !arranging,
        header: pageActive ? header : idleHeader,
      }),
    [renderPage, ids, focused, arranging, header, idleHeader],
  );

  const tabLabel = t(TAB_LABEL_KEYS[tab]);

  if (!activeId) return <View style={styles.fill} testID={testID} />;

  return (
    <View ref={rootRef} onLayout={measureRoot} style={styles.fill} testID={testID}>
      {/* The page background: FIRST, so it paints behind everything. */}
      <AbstractGradientBackdrop />

      <PagePager
          index={index}
          count={ids.length}
          keyOf={(i) => ids[i]}
          renderPanel={renderPanel}
          keep={keep}
          onIndexChange={(i) => pick(ids[i])}
          onTabStep={onTabStep}
          prevTabLabel={prevTab ? t(TAB_LABEL_KEYS[prevTab]) : undefined}
          nextTabLabel={nextTab ? t(TAB_LABEL_KEYS[nextTab]) : undefined}
          enabled={!arranging}
          progress={tabSwipeProgress(tab)}
          contentOpacity={opacity}
          testID={testID ? `${testID}-pager` : undefined}
        />

      {/* The header is TRANSPARENT (owner): the page's own gradient shows
          through it, with no status-bar band at rest. Only once it slides
          away does a chrome band cover the status bar, so the list never
          scrolls behind the clock. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.statusCover, { height: insets.top, backgroundColor: colors.chrome }, coverStyle]}
      />

      <Animated.View
        testID={testID ? `${testID}-header` : undefined}
        onLayout={onHeaderLayout}
        // box-none: the header must not swallow a pull-to-refresh that starts
        // under it; only its controls take touches.
        pointerEvents="box-none"
        style={[styles.header, headerStyle]}
      >
        {/* Symmetric sides, so a segmented track centres on the SCREEN. */}
        <View
          pointerEvents="box-none"
          style={{
            paddingTop: insets.top + HEADER_TOP_PAD,
            paddingBottom: HEADER_BOTTOM_PAD,
            paddingHorizontal: HEADER_SIDE_PAD,
          }}
        >
          <PageStrip
            tabLabel={tabLabel}
            pages={pages}
            activeId={activeId}
            onSelect={pick}
            // World keeps a scrolling row (its countries can grow); every
            // other tab is one centred track.
            variant={tab === 'world' ? 'scroll' : 'segmented'}
            leading={leading}
            onSearch={onSearch}
            // Only World arranges, by a long press on a page name.
            onLongPressPill={arrange ? setArrangeLift : undefined}
          />
        </View>
      </Animated.View>

      <PageExplainerSheet
        explainer={pageMeta(activeId).explainer}
        open={explaining}
        onClose={() => setExplaining(false)}
      />

      {arranging && arrange ? (
        <ArrangeOverlay
          tabLabel={tabLabel}
          pages={pages}
          arrange={arrange}
          initialLiftedId={arrangeLift}
          onClose={() => setArrangeLift(null)}
        />
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  statusCover: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5 },
});

export default TabPages;
