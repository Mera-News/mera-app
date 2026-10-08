// The tab shell: the page strip header, one collapsing header shared by the
// tab's pages, the page swipe (PagePager, within this tab only),
// the one explainer sheet behind the header's ?, and World's Arrange
// overlay. Content lanes render it from their page-set
// component (FeedPages, WorldPages, LibraryPages, YouPages) and draw only
// their pages.
//
//  - The active page is tracked by ID, so a reorder, or World adding or
//    removing a country, never moves the reader. If the active page goes
//    away (its country removed), its left neighbour takes over.
//  - A page is `active` only while it is the visible page AND this screen is
//    focused (tab focused, nothing pushed over it in the tab's stack).
//  - Page requests arrive through navigate-to-page's one-shot pending store
//    (`navigateToPage`: shortcuts, redirect stubs, deep links), taken on
//    focus, or at once while focused. A plain tap on the tab keeps the page
//    it was on.
//  - The surface is reported for the Mera button and the jump-origin Back.
//  - One collapsing header for all pages, as the Dashboard had: a page change
//    reveals it and resets its scroll origin (pages keep their own offsets).

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { hapticSelection } from '@/lib/haptics';
import { useCollapsibleHeader } from '@/lib/hooks/use-collapsible-header';
import { useIsFocused } from '@react-navigation/native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import ArrangeOverlay from './ArrangeOverlay';
import {
  clearHeaderBottom,
  clearSurface,
  headerBottomInWindow,
  reportHeaderBottom,
  reportSurface,
} from './current-surface';
import { consumePendingPage, usePendingPageRequest } from './navigate-to-page';
import PageExplainerSheet from './PageExplainerSheet';
import PagePager from './PagePager';
import { survivingPage } from './tab-swipe';
import PageStrip, { HEADER_BOTTOM_PAD, HEADER_SIDE_PAD, HEADER_TOP_PAD } from './PageStrip';
import { PAGE_SIDE_INSET, pageMeta, TAB_LABEL_KEYS, type PageId } from './page-registry';
import { tabSwipeProgress } from './swipe-progress';
import type { PageHeaderBinding, TabPagesProps } from './types';

export type { TabPagesProps } from './types';

const TabPages: React.FC<TabPagesProps> = ({
  tab,
  pages,
  renderPage,
  onSearch,
  arrange,
  leading,
  namesFirst,
  iconsOnly,
  renderAccessory,
  title,
  renderTitleChip,
  testID,
}) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const { scrollHandler, headerStyle, onHeaderLayout, headerHeight, reveal, resetScrollOrigin, hidden } =
    useCollapsibleHeader();

  const ids = useMemo(() => pages.map((p) => p.id), [pages]);
  const [chosenId, setChosenId] = useState<PageId | null>(null);
  const lastIndexRef = useRef(0);
  const activeId = survivingPage(ids, chosenId ?? ids[0] ?? null, lastIndexRef.current);
  const index = activeId ? Math.max(0, ids.indexOf(activeId)) : 0;
  lastIndexRef.current = index;
  // World's overlay: open, with the long-pressed page lifted.
  // World's overlay: open (from a long press, with that page lifted, or from
  // the row's edit button, with none).
  const [arranging, setArranging] = useState(false);
  const [arrangeLift, setArrangeLift] = useState<PageId | null>(null);
  const openArrange = useCallback((lift: PageId | null) => {
    setArrangeLift(lift);
    setArranging(true);
  }, []);
  // The ? in the header: ONE sheet per tab (not one per warm panel), showing
  // the ACTIVE page's explainer, closed whenever the tab loses focus (a sheet
  // survives a tab switch).
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

  // ── Requests from elsewhere: a page ──
  const request = usePendingPageRequest();
  useEffect(() => {
    if (!focused || ids.length === 0) return;
    const req = consumePendingPage(tab);
    if (req && ids.includes(req.page)) select(req.page);
  }, [focused, request, ids, tab, select]);

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
  // The track row's block alone (status inset included), WITHOUT the page's
  // accessory: the Mera button's top bound must not move when the Feed's
  // stats card opens.
  const [stripHeight, setStripHeight] = useState(0);
  const measureRoot = useCallback(() => {
    rootRef.current?.measureInWindow((_x, y) => {
      if (Number.isFinite(y)) setRootY((prev) => (prev === y ? prev : y));
    });
  }, []);
  useEffect(() => {
    if (focused) measureRoot();
  }, [focused, measureRoot]);
  useEffect(() => {
    if (!focused || stripHeight <= 0 || rootY === null) return;
    reportHeaderBottom(`tab:${tab}`, headerBottomInWindow(rootY, stripHeight));
  }, [focused, stripHeight, rootY, tab]);
  // Cleared only on blur or unmount, so a re-report never flickers through null.
  useEffect(() => {
    if (!focused) return undefined;
    return () => clearHeaderBottom(`tab:${tab}`);
  }, [focused, tab]);


  const header: PageHeaderBinding = useMemo(
    () => ({ scrollHandler, headerHeight, hidden, reveal }),
    [scrollHandler, headerHeight, hidden, reveal],
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
  const accessory = activeId ? renderAccessory?.(activeId) : null;
  const activeLabel = pages.find((p) => p.id === activeId)?.label ?? tabLabel;
  const hasExplainer = activeId !== null && pageMeta(activeId).explainer !== null;

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
          enabled={!arranging}
          progress={tabSwipeProgress(tab)}
          testID={testID ? `${testID}-pager` : undefined}
        />

      {/* The header is TRANSPARENT (owner), and nothing covers the status
          bar: content runs up under the clock and the Dynamic Island. */}

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
          onLayout={(e) => {
            const h = e.nativeEvent.layout.height;
            setStripHeight((prev) => (prev === h ? prev : h));
          }}
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
            namesFirst={namesFirst}
            iconsOnly={iconsOnly}
            onSearch={onSearch}
            onHelp={hasExplainer ? openExplainer : undefined}
            helpLabel={t('nav.explainerA11y', { page: activeLabel })}
            title={title}
            titleChip={renderTitleChip?.(activeId)}
            // Only World arranges, by a long press on a page name.
            onLongPressPill={arrange ? openArrange : undefined}
            onEdit={arrange && !arranging ? () => openArrange(null) : undefined}
          />
        </View>
        {accessory ? (
          <View pointerEvents="box-none" style={styles.accessory} testID={testID ? `${testID}-accessory` : undefined}>
            {accessory}
          </View>
        ) : null}
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
          onClose={() => {
            setArranging(false);
            setArrangeLift(null);
          }}
        />
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // On the page's side inset; the header's own bottom pad stays under it.
  accessory: { paddingHorizontal: PAGE_SIDE_INSET, paddingBottom: HEADER_BOTTOM_PAD },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
});

export default TabPages;
