// The tab header: the page pills (the title is the active pill), then, pinned
// outside the scroller, the pen, the quick-settings button where the page has
// one, and the bell (or World's search).
//
//  - Active pill: solid accent, dark label. Others: glass, white label. New
//    content is a 7pt dot, never a count, so the strip never changes width;
//    the dot is in the label ("new updates") and gets a dark ring on the
//    active pill.
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
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';

import QuickSettingsButton, { NAV_ACCENT } from './QuickSettingsButton';
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
  readonly onRearrange: () => void;
  readonly quickSettings: readonly QuickSettingsFocusId[] | null;
  readonly trailing: TabTrailing;
}

const NO_DOT: PageDot = { visible: false };
const noDot = () => NO_DOT;

interface PillProps {
  readonly pill: PagePill;
  readonly active: boolean;
  readonly position: number;
  readonly count: number;
  readonly onSelect: (id: PageId) => void;
  readonly onLayout: (id: PageId, x: number, width: number) => void;
}

/** One pill. Its own component, keyed by page id, so the page's dot hook is
 *  called in a stable place however the pages are reordered. */
const Pill: React.FC<PillProps> = ({ pill, active, position, count, onSelect, onLayout }) => {
  const { t } = useTranslation();
  const useDot = pill.useDot ?? noDot;
  const dot = useDot();
  const label = dot.visible
    ? t('nav.pillNewA11y', { label: pill.label, index: position, count })
    : t('nav.pillA11y', { label: pill.label, index: position, count });
  const flag = pill.flagAlpha2 ? flagEmoji(pill.flagAlpha2) : '';

  const inner = (
    <View style={styles.pillInner}>
      {flag ? <Text style={styles.flag}>{flag}</Text> : null}
      <Text
        size="sm"
        scaleTier="chrome"
        numberOfLines={1}
        className={active ? 'text-black font-semibold' : 'text-white'}
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

  return (
    <View
      style={{ paddingVertical: PILL_FRAME_PAD }}
      onLayout={(e) => onLayout(pill.id, e.nativeEvent.layout.x, e.nativeEvent.layout.width)}
      testID={`page-pill-${pill.id}-frame`}
    >
      <View pointerEvents="none" {...GLYPH_HIDDEN}>
        {active ? (
          <View style={[styles.pill, styles.pillActive]} testID={`page-pill-${pill.id}-chip`}>
            {inner}
          </View>
        ) : (
          <GlassPanel radius={999}>
            <View style={styles.pill} testID={`page-pill-${pill.id}-chip`}>
              {inner}
            </View>
          </GlassPanel>
        )}
      </View>
      <Pressable
        onPress={() => onSelect(pill.id)}
        accessibilityRole={ROLES.pill}
        accessibilityState={{ selected: active }}
        accessibilityLabel={label}
        testID={`page-pill-${pill.id}`}
        style={StyleSheet.absoluteFill}
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
}) => {
  const { t } = useTranslation();
  const scrollRef = useRef<ScrollView>(null);
  const layouts = useRef<Partial<Record<string, { x: number; width: number }>>>({});
  const onPillLayout = (id: PageId, x: number, width: number) => {
    layouts.current[id] = { x, width };
  };

  useEffect(() => {
    const l = layouts.current[activeId];
    if (l) scrollRef.current?.scrollTo({ x: Math.max(0, l.x - 14), animated: true });
  }, [activeId]);

  const activeLabel = pages.find((p) => p.id === activeId)?.label ?? tabLabel;

  return (
    <View style={styles.row} pointerEvents="box-none" testID="page-strip">
      <View style={styles.scrollerWrap} pointerEvents="box-none">
        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.scrollerContent}
          testID="page-strip-scroll"
        >
          <View style={styles.pills} accessibilityRole={ROLES.row} testID="page-strip-pills">
            {pages.map((p, i) => (
              <Pill
                key={p.id}
                pill={p}
                active={p.id === activeId}
                position={i + 1}
                count={pages.length}
                onSelect={onSelect}
                onLayout={onPillLayout}
              />
            ))}
          </View>
        </ScrollView>
      </View>

      <View style={styles.penFrame} testID="page-strip-rearrange-frame">
        <View pointerEvents="none" {...GLYPH_HIDDEN}>
          <MaterialIcons name="edit" size={18} color={NAV_ACCENT} />
        </View>
        <Pressable
          onPress={onRearrange}
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel={t('nav.rearrangeA11y', { tab: tabLabel })}
          testID="page-strip-rearrange"
        />
      </View>

      {quickSettings ? <QuickSettingsButton targets={quickSettings} pageLabel={activeLabel} /> : null}

      {trailing === 'bell' ? (
        <View style={styles.trailingFrame}>
          <NotificationBellButton />
        </View>
      ) : (
        <View style={styles.trailingFrame} testID="page-strip-search-frame">
          <View pointerEvents="none" {...GLYPH_HIDDEN}>
            <MaterialIcons name="search" size={24} color="#FFFFFF" />
          </View>
          <Pressable
            onPress={trailing.onPress}
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel={t('world.search.placeholder')}
            testID="page-strip-search"
          />
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  scrollerWrap: { flex: 1, marginVertical: -PILL_FRAME_PAD },
  scrollerContent: { paddingLeft: 14, paddingRight: 8 },
  pills: { flexDirection: 'row', alignItems: 'center', gap: PILL_GAP },
  pill: {
    height: PILL_HEIGHT,
    paddingHorizontal: 13,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    justifyContent: 'center',
  },
  pillActive: { backgroundColor: NAV_ACCENT, borderColor: NAV_ACCENT },
  pillInner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  flag: { fontSize: 13, lineHeight: 16 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: NAV_ACCENT, marginLeft: -2 },
  dotOnActive: { borderWidth: 1.5, borderColor: '#121113', width: 9, height: 9, borderRadius: 5 },
  penFrame: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  trailingFrame: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});

export default PageStrip;
