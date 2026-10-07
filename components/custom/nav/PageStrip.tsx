// The tab header: the page pills, in one of two shapes, then the controls
// pinned outside the scroller.
//
//  - `segmented` (Feed, Library, You): one centred track. A single orange pill
//    sits behind the active page and travels with the pager's fractional
//    `progress`, so it follows the finger and the slide after it. The track
//    scrolls instead of centring when a long locale makes it wider than the
//    screen. Reduce Motion: the active pill fills itself, no travel.
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

import { GlassPanel } from '@/components/custom/GlassSurface';
import NotificationBellButton from '@/components/custom/notifications/NotificationBellButton';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
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
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

import { HEADER_ICON_COLOR } from '@/components/custom/for-you/HeaderIconButton';
import { COLORS, useColors } from '@/lib/theme/tokens';
import { indicatorAt } from './tab-swipe';
import QuickSettingsButton from './QuickSettingsButton';
import type { PageId, QuickSettingsFocusId } from './page-registry';
import type { PageDot, PagePill, TabTrailing } from './types';

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
/** The segmented track's inset around its pills (3pt) plus its 1pt border. */
const TRACK_PAD = 4;
const SIDE_SLOT = 44;
const LONG_PRESS_MS = 400;
/** World's strip: where the leading fade runs out, and where the trailing
 *  fade starts and ends measured back from the search button's edge. */
const LEAD_FADE = 44;
const TRAIL_FADE_START = 58;
const TRAIL_FADE_END = 96;
const SCROLL_PAD_LEFT = 16;
/** Room for the floating search button at the scroll row's end. */
const SCROLL_PAD_RIGHT = 60;

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
  /** The pen (Feed, Library, You until the shell drops it). */
  readonly onRearrange?: () => void;
  readonly quickSettings: readonly QuickSettingsFocusId[] | null;
  /** Absent: nothing after the pills. */
  readonly trailing?: TabTrailing;
  /** Default `scroll`. */
  readonly variant?: 'segmented' | 'scroll';
  /** The pager's fractional page index; the segmented pill travels with it. */
  readonly progress?: SharedValue<number>;
  /** Drawn in a 44pt frame at the row's start (the Feed's status icon). */
  readonly leading?: React.ReactNode;
  /** A long press on a pill (World: opens Arrange with that page lifted). */
  readonly onLongPressPill?: (id: PageId) => void;
}

const NO_DOT: PageDot = { visible: false };
const noDot = () => NO_DOT;

interface PillProps {
  readonly pill: PagePill;
  readonly active: boolean;
  readonly position: number;
  readonly count: number;
  readonly segmented: boolean;
  /** The travelling pill draws the fill; this one draws only its label. */
  readonly fillDrawnBehind: boolean;
  readonly tabLabel: string;
  readonly onSelect: (id: PageId) => void;
  readonly onLongPress?: (id: PageId) => void;
  readonly onLayout: (id: PageId, x: number, width: number) => void;
  readonly fade?: { scrollX: SharedValue<number>; viewport: SharedValue<number> };
}

/** One pill. Its own component, keyed by page id, so the page's dot hook is
 *  called in a stable place however the pages are reordered. */
const Pill: React.FC<PillProps> = ({
  pill,
  active,
  position,
  count,
  segmented,
  fillDrawnBehind,
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
  const ink = active ? colors.onAccent : segmented ? colors.muted : colors.ink;

  // World only: this pill's own place in the row, for its edge fade.
  const x = useSharedValue(0);
  const w = useSharedValue(0);
  const fadeStyle = useAnimatedStyle(() => {
    if (!fade || w.value === 0) return { opacity: 1 };
    // x is inside the row's content, after its leading padding.
    const centre = SCROLL_PAD_LEFT + x.value + w.value / 2 - fade.scrollX.value;
    const lead = interpolate(centre, [0, LEAD_FADE], [0, 1], Extrapolation.CLAMP);
    const trail = interpolate(
      fade.viewport.value - centre,
      [TRAIL_FADE_START, TRAIL_FADE_END],
      [0, 1],
      Extrapolation.CLAMP,
    );
    return { opacity: Math.min(lead, trail) };
  });

  const inner = (
    <View style={styles.pillInner}>
      {pill.icon ? <MaterialIcons name={pill.icon} size={14} color={ink} /> : null}
      {flag ? <Text style={styles.flag}>{flag}</Text> : null}
      <Text
        size="sm"
        scaleTier="chrome"
        numberOfLines={1}
        style={{ color: ink }}
        className={active ? 'font-semibold' : undefined}
      >
        {pill.label}
      </Text>
      {dot.visible ? (
        <View
          testID={`page-pill-${pill.id}-dot`}
          style={[styles.dot, active ? styles.dotOnActive : null]}
        />
      ) : null}
    </View>
  );

  let visual: React.ReactNode;
  if (segmented) {
    visual = (
      <View
        style={[styles.pill, styles.segPill, active && !fillDrawnBehind ? styles.pillActive : null]}
        testID={`page-pill-${pill.id}-chip`}
      >
        {inner}
      </View>
    );
  } else if (active) {
    visual = (
      <View style={[styles.pill, styles.pillActive]} testID={`page-pill-${pill.id}-chip`}>
        {inner}
      </View>
    );
  } else {
    visual = (
      <GlassPanel radius={999}>
        <View style={styles.pill} testID={`page-pill-${pill.id}-chip`}>
          {inner}
        </View>
      </GlassPanel>
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
      <View pointerEvents="none" {...GLYPH_HIDDEN} style={styles.searchShadow}>
        <GlassPanel radius={22}>
          <View style={styles.searchCircle}>
            <MaterialIcons name="search" size={22} color={colors.ink} />
          </View>
        </GlassPanel>
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
  onRearrange,
  quickSettings,
  trailing,
  variant = 'scroll',
  progress,
  leading,
  onLongPressPill,
}) => {
  const { t } = useTranslation();
  const segmented = variant === 'segmented';
  const reduceMotion = useReducedMotion();
  const travelling = segmented && !!progress && !reduceMotion;

  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const layouts = useRef<Partial<Record<string, { x: number; width: number }>>>({});

  // The segmented pill's stops, in page order, once every pill is measured.
  const xs = useSharedValue<number[]>([]);
  const widths = useSharedValue<number[]>([]);
  const onPillLayout = useCallback(
    (id: PageId, x: number, width: number) => {
      layouts.current[id] = { x, width };
      const all = pages.map((p) => layouts.current[p.id]);
      if (all.every(Boolean)) {
        xs.value = all.map((l) => l!.x);
        widths.value = all.map((l) => l!.width);
      }
    },
    [pages, xs, widths],
  );

  const indicatorStyle = useAnimatedStyle(() => {
    const at = indicatorAt(progress ? progress.value : 0, xs.value, widths.value);
    return { transform: [{ translateX: at.x }], width: at.width, opacity: at.width > 0 ? 1 : 0 };
  });

  // World's edge fade reads these on the UI thread.
  const scrollX = useSharedValue(0);
  const viewport = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      scrollX.value = e.contentOffset.x;
    },
  });
  const fade = segmented ? undefined : { scrollX, viewport };

  useEffect(() => {
    const l = layouts.current[activeId];
    if (l) scrollRef.current?.scrollTo({ x: Math.max(0, l.x), animated: true });
  }, [activeId, scrollRef]);

  const pills = pages.map((p, i) => (
    <Pill
      key={p.id}
      pill={p}
      active={p.id === activeId}
      position={i + 1}
      count={pages.length}
      segmented={segmented}
      fillDrawnBehind={travelling}
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
      <View style={styles.scrollerWrap} pointerEvents="box-none">
        <Animated.ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={segmented ? styles.segContent : styles.scrollContent}
          onScroll={segmented ? undefined : onScroll}
          scrollEventThrottle={16}
          onLayout={(e) => {
            viewport.value = e.nativeEvent.layout.width;
          }}
          testID="page-strip-scroll"
        >
          {segmented ? (
            <View style={styles.track} accessibilityRole={ROLES.row} testID="page-strip-pills">
              <View style={styles.trackPlate} pointerEvents="none" {...GLYPH_HIDDEN} />
              {travelling ? (
                <Animated.View
                  style={[styles.indicator, indicatorStyle]}
                  pointerEvents="none"
                  {...GLYPH_HIDDEN}
                  testID="page-strip-indicator"
                />
              ) : null}
              {pills}
            </View>
          ) : (
            <View style={styles.pills} accessibilityRole={ROLES.row} testID="page-strip-pills">
              {pills}
            </View>
          )}
        </Animated.ScrollView>
      </View>
      {/* Keeps a segmented track centred on the screen beside a leading icon. */}
      {leading && segmented ? <View style={styles.sideSlot} /> : null}

      {onRearrange ? (
        <View style={styles.penFrame} testID="page-strip-rearrange-frame">
          <View pointerEvents="none" {...GLYPH_HIDDEN}>
            <MaterialIcons name="edit" size={18} color={HEADER_ICON_COLOR} testID="page-strip-rearrange-glyph" />
          </View>
          <Pressable
            onPress={onRearrange}
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel={t('nav.rearrangeA11y', { tab: tabLabel })}
            testID="page-strip-rearrange"
          />
        </View>
      ) : null}

      {quickSettings ? (
        <QuickSettingsButton targets={quickSettings} pageLabel={pages.find((p) => p.id === activeId)?.label ?? tabLabel} />
      ) : null}

      {trailing === 'bell' ? (
        <View style={styles.trailingFrame}>
          <NotificationBellButton />
        </View>
      ) : trailing ? (
        <SearchButton onPress={trailing.onPress} />
      ) : null}
    </View>
  );
};

// P12 moves these onto useColors().
const C = COLORS.dark;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  sideSlot: { width: SIDE_SLOT, height: SIDE_SLOT, alignItems: 'center', justifyContent: 'center' },
  scrollerWrap: { flex: 1, marginVertical: -PILL_FRAME_PAD },
  scrollContent: { paddingLeft: SCROLL_PAD_LEFT, paddingRight: SCROLL_PAD_RIGHT },
  // Centred while it fits, scrolls once it does not.
  segContent: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 8 },
  pills: { flexDirection: 'row', alignItems: 'center', gap: PILL_GAP },
  track: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: TRACK_PAD },
  // The plate is 1pt inside the 44pt frames: 34 + 2 * 3 inset + 2 * 1 border.
  trackPlate: {
    position: 'absolute',
    top: PILL_FRAME_PAD - TRACK_PAD,
    bottom: PILL_FRAME_PAD - TRACK_PAD,
    left: 0,
    right: 0,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.trackBorder,
    backgroundColor: C.trackFill,
  },
  indicator: {
    position: 'absolute',
    left: 0,
    top: PILL_FRAME_PAD,
    height: PILL_HEIGHT,
    borderRadius: 999,
    backgroundColor: C.accent,
  },
  pill: {
    height: PILL_HEIGHT,
    paddingHorizontal: 13,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.trackBorder,
    justifyContent: 'center',
  },
  segPill: { borderColor: 'transparent' },
  pillActive: { backgroundColor: C.accent, borderColor: C.accent },
  pillInner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  flag: { fontSize: 13, lineHeight: 16 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.accent, marginLeft: -2 },
  dotOnActive: { borderWidth: 1.5, borderColor: C.onAccent, width: 9, height: 9, borderRadius: 5 },
  penFrame: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  trailingFrame: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  searchFab: { position: 'absolute', right: 4, top: 0, width: 44, height: 44 },
  searchShadow: {
    borderRadius: 22,
    shadowColor: '#000000',
    shadowOpacity: 0.5,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 4 },
  },
  searchCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: C.trackBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default PageStrip;
