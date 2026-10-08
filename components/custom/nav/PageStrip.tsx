// The tab header: the page pills, in one of two shapes, then the controls
// pinned outside the scroller.
//
//  - `segmented` (Feed, Library, You): one centred track, the shared
//    `SegmentedControl` at its header size. The selected fill is drawn INSIDE
//    the selected tab (exactly its bounds) and crossfades on a page change; it
//    does not follow the finger. The track scrolls instead of centring when a
//    long locale makes it wider than the screen.
//  - `scroll` (World): a scrolling row of glass pills. Pills fade by distance
//    from the leading edge and from the floating search button, per pill on
//    the UI thread (no JS per scroll frame).
//  - New content is a 7pt dot, never a count, so the strip never changes
//    width.
//  - Pills draw 34pt tall in a 44pt frame (padding given back by the row's
//    negative margin, never hitSlop: the scroller clips touches).
//  - VoiceOver: iOS maps `tab` to no trait, so a pill is a button in a tabbar
//    container and its label carries "2 of 5"; Android gets real tab roles.
//  - The active pill scrolls into view.

import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

import { inlineSign } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';
import type { PageId } from './page-registry';
import type { PageDot, PagePill } from './types';

const GLYPH_HIDDEN = {
  accessible: false,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;

/** iOS has no tab trait (RN maps `tab` to nothing): button in a tabbar. */
export function pillA11yRoles(os: string): { row: 'tabbar' | 'tablist'; pill: 'button' | 'tab' } {
  return os === 'ios' ? { row: 'tabbar', pill: 'button' } : { row: 'tablist', pill: 'tab' };
}
const ROLES = pillA11yRoles(Platform.OS);

export const PILL_HEIGHT = 34;
/** Frame padding around a 34pt pill: 44pt touch target. */
export const PILL_FRAME_PAD = 5;
const PILL_GAP = 6;
const SIDE_SLOT = 44;
const LONG_PRESS_MS = 400;
/** The tab header's side padding (TabPages). World's row cancels it, so its
 *  scroller spans the screen and a pill fades out before the screen edge. */
export const HEADER_SIDE_PAD = 6;
/** The board's header, measured from the safe-area top: the track at +5, 42pt
 *  tall, and the header's bottom 5pt under it (+52). */
export const HEADER_TOP_PAD = 5;
export const HEADER_ROW_HEIGHT = 42;
export const HEADER_BOTTOM_PAD = 5;
/** World's row starts 16pt in; a pill is fully faded once its start edge
 *  reaches the screen edge, so it is never cut square. */
const ROW_START = 16;
/** Trailing fade: from fully clear to full, measured back from the row end,
 *  where the floating search button sits. */
const TRAIL_FADE_START = 58;
const TRAIL_FADE_END = 96;
/** Room for the floating search button at the row's end. */
const ROW_END = 60;

/** Regional-indicator flag from ISO alpha-2 (XK included); '' when invalid. */
export function flagEmoji(alpha2: string): string {
  const a = alpha2.toUpperCase();
  if (!/^[A-Z]{2}$/.test(a)) return '';
  return String.fromCodePoint(...[...a].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export interface PageStripProps {
  readonly tabLabel: string;
  readonly pages: readonly PagePill[];
  readonly activeId: PageId;
  readonly onSelect: (id: PageId) => void;
  /** World: the floating search button at the row's end. */
  readonly onSearch?: () => void;
  /** Default `scroll`. */
  readonly variant?: 'segmented' | 'scroll';
  /** Drawn in a 44pt frame at the row's start (the Feed's status icon). */
  readonly leading?: React.ReactNode;
  /** A long press on a pill (World: opens Arrange with that page lifted). */
  readonly onLongPressPill?: (id: PageId) => void;
  /** World: the edit button after the last pill (opens Arrange). Absent while
   *  Arrange is open, which has its own ✓. */
  readonly onEdit?: () => void;
}

const NO_DOT: PageDot = { visible: false };
const noDot = () => NO_DOT;

interface PillProps {
  readonly pill: PagePill;
  readonly active: boolean;
  readonly position: number;
  readonly count: number;
  readonly tabLabel: string;
  readonly onSelect: (id: PageId) => void;
  readonly onLongPress?: (id: PageId) => void;
  readonly onLayout: (id: PageId, x: number, width: number) => void;
  readonly fade?: RowFade;
}

type RowFade = { scrollX: SharedValue<number>; viewport: SharedValue<number>; rtl: boolean };

/** World's per-item edge fade, on the UI thread: an item fades to clear as its
 *  start edge reaches the screen edge, and before the floating search button.
 *  Write the item's layout x and width into `x` and `w`. */
function useEdgeFade(fade: RowFade | undefined) {
  const x = useSharedValue(0);
  const w = useSharedValue(0);
  const fadeStyle = useAnimatedStyle(() => {
    if (!fade || w.value === 0) return { opacity: 1 };
    // Physical on-screen edges (layout x and the scroll offset are both
    // physical); the row's START is the right edge in RTL.
    const left = x.value - fade.scrollX.value;
    const right = left + w.value;
    const centre = left + w.value / 2;
    const view = fade.viewport.value;
    const toStart = fade.rtl ? view - right : left;
    const toEnd = fade.rtl ? centre : view - centre;
    const lead = interpolate(toStart, [0, ROW_START], [0, 1], Extrapolation.CLAMP);
    const trail = interpolate(toEnd, [TRAIL_FADE_START, TRAIL_FADE_END], [0, 1], Extrapolation.CLAMP);
    return { opacity: Math.min(lead, trail) };
  });
  return { x, w, fadeStyle };
}

/** World's edit button: the last item of the row, opening Arrange. The same
 *  flat glass circle as the search button. */
const EditButton: React.FC<{ readonly onPress: () => void; readonly label: string; readonly fade?: RowFade }> = ({
  onPress,
  label,
  fade,
}) => {
  const colors = useColors();
  const { x, w, fadeStyle } = useEdgeFade(fade);
  return (
    <Animated.View
      style={[styles.editFrame, fade ? fadeStyle : null]}
      onLayout={(e) => {
        x.value = e.nativeEvent.layout.x;
        w.value = e.nativeEvent.layout.width;
      }}
    >
      <View pointerEvents="none" {...GLYPH_HIDDEN}>
        <View style={[styles.searchCircle, { backgroundColor: colors.glass, borderColor: colors.trackBorder }]}>
          <MaterialIcons name="edit" size={22} color={colors.ink} />
        </View>
      </View>
      <Pressable
        onPress={onPress}
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={label}
        testID="world-edit-pages"
      />
    </Animated.View>
  );
};

/** One pill. Its own component, keyed by page id, so the page's dot hook is
 *  called in a stable place however the pages are reordered. */
const Pill: React.FC<PillProps> = ({
  pill,
  active,
  position,
  count,
  tabLabel,
  onSelect,
  onLongPress,
  onLayout,
  fade,
}) => {
  const { t } = useTranslation();
  const useDot = pill.useDot ?? noDot;
  const dot = useDot();
  const label = dot.visible
    ? t('nav.pillNewA11y', { label: pill.label, index: position, count })
    : t('nav.pillA11y', { label: pill.label, index: position, count });
  const flag = pill.flagAlpha2 ? flagEmoji(pill.flagAlpha2) : '';
  const colors = useColors();
  const ink = active ? colors.onAccent : colors.ink;
  const accentFill = { backgroundColor: colors.accent, borderColor: colors.accent };

  const { x, w, fadeStyle } = useEdgeFade(fade);

  const inner = (
    <View style={styles.pillInner}>
      {pill.icon ? <MaterialIcons name={pill.icon} size={14} color={ink} /> : null}
      {flag ? <Text style={styles.flag}>{flag}</Text> : null}
      <Text
        numberOfLines={1}
        // Board .tb: 14pt, 500 (700 picked), in a fixed 34pt pill, so it never
        // grows with Dynamic Type.
        maxFontSizeMultiplier={1}
        style={[styles.label, { color: ink, fontWeight: active ? '700' : '500' }]}
      >
        {pill.label}
      </Text>
      {dot.visible ? (
        <View
          testID={`page-pill-${pill.id}-dot`}
          style={[styles.dot, { backgroundColor: colors.accent }, active ? [styles.dotOnActive, { borderColor: colors.onAccent }] : null]}
        />
      ) : null}
    </View>
  );

  let visual: React.ReactNode;
  if (active) {
    visual = (
      <View style={[styles.pill, accentFill]} testID={`page-pill-${pill.id}-chip`}>
        {inner}
      </View>
    );
  } else {
    visual = (
      // A flat fill, not liquid glass (whose native shadow made a heavy pill).
      <View
        style={[styles.pill, { backgroundColor: colors.glass, borderColor: colors.trackBorder }]}
        testID={`page-pill-${pill.id}-chip`}
      >
        {inner}
      </View>
    );
  }

  const actions = onLongPress ? [{ name: 'rearrange', label: t('nav.rearrangeA11y', { tab: tabLabel }) }] : undefined;
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'rearrange') onLongPress?.(pill.id);
  };

  return (
    <Animated.View
      style={[{ paddingVertical: PILL_FRAME_PAD }, fade ? fadeStyle : null]}
      onLayout={(e) => {
        const l = e.nativeEvent.layout;
        x.value = l.x;
        w.value = l.width;
        onLayout(pill.id, l.x, l.width);
      }}
      testID={`page-pill-${pill.id}-frame`}
    >
      <View pointerEvents="none" {...GLYPH_HIDDEN}>
        {visual}
      </View>
      <Pressable
        onPress={() => onSelect(pill.id)}
        onLongPress={onLongPress ? () => onLongPress(pill.id) : undefined}
        delayLongPress={LONG_PRESS_MS}
        accessibilityRole={ROLES.pill}
        accessibilityState={{ selected: active }}
        accessibilityLabel={label}
        accessibilityActions={actions}
        onAccessibilityAction={actions ? onAction : undefined}
        testID={`page-pill-${pill.id}`}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
};

/** The floating round search button at the end of World's strip. */
const SearchButton: React.FC<{ readonly onPress: () => void }> = ({ onPress }) => {
  const { t } = useTranslation();
  const colors = useColors();
  return (
    <View style={styles.searchFab} testID="page-strip-search-frame">
      {/* The same flat glass as the World pills, no shadow, in both themes. */}
      <View pointerEvents="none" {...GLYPH_HIDDEN}>
        <View style={[styles.searchCircle, { backgroundColor: colors.glass, borderColor: colors.trackBorder }]}>
          <MaterialIcons name="search" size={22} color={colors.ink} />
        </View>
      </View>
      <Pressable
        onPress={onPress}
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={t('world.search.placeholder')}
        testID="page-strip-search"
      />
    </View>
  );
};

const PageStrip: React.FC<PageStripProps> = ({
  tabLabel,
  pages,
  activeId,
  onSelect,
  onSearch,
  variant = 'scroll',
  leading,
  onLongPressPill,
  onEdit,
}) => {
  const { t } = useTranslation();
  const segmented = variant === 'segmented';

  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const layouts = useRef<Partial<Record<string, { x: number; width: number }>>>({});
  const onPillLayout = useCallback((id: PageId, x: number, width: number) => {
    layouts.current[id] = { x, width };
  }, []);

  // World's edge fade reads these on the UI thread.
  const scrollX = useSharedValue(0);
  const viewport = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      scrollX.value = e.contentOffset.x;
    },
  });
  const fade = segmented ? undefined : { scrollX, viewport, rtl: inlineSign() === -1 };

  useEffect(() => {
    const l = layouts.current[activeId];
    if (l) scrollRef.current?.scrollTo({ x: Math.max(0, l.x - ROW_START), animated: true });
  }, [activeId, scrollRef]);

  const pills = pages.map((p, i) => (
    <Pill
      key={p.id}
      pill={p}
      active={p.id === activeId}
      position={i + 1}
      count={pages.length}
      tabLabel={tabLabel}
      onSelect={onSelect}
      onLongPress={onLongPressPill}
      onLayout={onPillLayout}
      fade={fade}
    />
  ));

  return (
    <View style={styles.row} pointerEvents="box-none" testID="page-strip">
      {leading ? <View style={styles.sideSlot}>{leading}</View> : null}
      <View style={[styles.scrollerWrap, segmented ? null : [styles.rowBleed, styles.fullBleed]]} pointerEvents="box-none">
        <Animated.ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={segmented ? styles.segContent : undefined}
          onScroll={segmented ? undefined : onScroll}
          scrollEventThrottle={16}
          onLayout={(e) => {
            viewport.value = e.nativeEvent.layout.width;
          }}
          testID="page-strip-scroll"
        >
          {segmented ? (
            <SegmentedControl
              size="header"
              value={activeId}
              onChange={onSelect}
              accessibilityLabel={tabLabel}
              testID="page-pill"
              options={pages.map((p, i) => ({
                value: p.id,
                label: p.label,
                icon: p.icon,
                useDot: p.useDot ? () => (p.useDot ?? noDot)().visible : undefined,
                accessibilityLabelFor: (dot: boolean) =>
                  t(dot ? 'nav.pillNewA11y' : 'nav.pillA11y', { label: p.label, index: i + 1, count: pages.length }),
              }))}
            />
          ) : (
            // The row's own padding (not the scroller's), so each pill's
            // layout x is its place in the scrolled content.
            <View style={[styles.pills, styles.rowPad]} accessibilityRole={ROLES.row} testID="page-strip-pills">
              {pills}
              {onEdit ? (
                <EditButton onPress={onEdit} label={t('nav.rearrangeA11y', { tab: tabLabel })} fade={fade} />
              ) : null}
            </View>
          )}
        </Animated.ScrollView>
      </View>
      {/* Keeps a segmented track centred on the screen beside a leading icon. */}
      {leading && segmented ? <View style={styles.sideSlot} /> : null}

      {onSearch ? <SearchButton onPress={onSearch} /> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  // A fixed row: the segmented track (42pt) fills it exactly; World's 44pt
  // pill frames reach 5pt past it through `rowBleed`.
  row: { flexDirection: 'row', alignItems: 'center', height: HEADER_ROW_HEIGHT },
  sideSlot: { width: SIDE_SLOT, height: HEADER_ROW_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  scrollerWrap: { flex: 1, height: HEADER_ROW_HEIGHT },
  rowBleed: { height: HEADER_ROW_HEIGHT + 2 * PILL_FRAME_PAD, marginVertical: -PILL_FRAME_PAD },
  fullBleed: { marginHorizontal: -HEADER_SIDE_PAD },
  rowPad: { paddingLeft: ROW_START, paddingRight: ROW_END },
  // Centred while it fits, scrolls once it does not.
  segContent: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 8 },
  pills: { flexDirection: 'row', alignItems: 'center', gap: PILL_GAP },
  pill: {
    height: PILL_HEIGHT,
    paddingHorizontal: 13,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
  },
  pillInner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { fontSize: 14, lineHeight: 18 },
  flag: { fontSize: 13, lineHeight: 16 },
  dot: { width: 7, height: 7, borderRadius: 4, marginLeft: -2 },
  dotOnActive: { borderWidth: 1.5, width: 9, height: 9, borderRadius: 5 },
  searchFab: { position: 'absolute', right: 4, top: -1, width: 44, height: 44 },
  editFrame: { width: 44, height: 44 },
  searchCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default PageStrip;
