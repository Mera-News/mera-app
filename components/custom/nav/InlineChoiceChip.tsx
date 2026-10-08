// One choice chip: World's time chip and the Feed's View chip. A 34pt flat
// glass pill "24h ⌄"; tapped, a floating menu opens under it, right-aligned
// to it (left-aligned in RTL), with the chosen option checked. The title row
// never moves or reflows, and nothing behind the menu is dimmed.
//
//  - The chip draws 34pt inside a 44pt frame given back by negative margins
//    (never hitSlop: QA measures a hitSlop target as its glyph box), a hidden
//    visual under a CHILDLESS labelled button (a glyph inside a button
//    surfaces on iOS as its own StaticText).
//  - The menu is an RN Modal (it must paint over the tab bar), transparent and
//    undimmed: a tap outside or Android back closes it, VoiceOver's escape
//    too. It is NOT gluestack's Menu: its PopoverContent hard-codes
//    `accessible`, so VoiceOver would read every option as one element.
//  - Placed from the chip's measured window position; the panel wears the
//    modals' and sheets' own material (`ChoiceMenuPanel`: ModalMaterial in a
//    clipped, edged container), opaque, so it reads over any content.
//  - Opens with a 150ms fade from 96% scale; Reduce Motion or Lite: fade only.

import ModalMaterial from '@/components/custom/ModalMaterial';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { hapticSelection } from '@/lib/haptics';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { useColors } from '@/lib/theme/tokens';

import { menuTop } from './menu-placement';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useRef, useState } from 'react';
import { I18nManager, Modal, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, Keyframe, useReducedMotion } from 'react-native-reanimated';

const PILL = 34;
const FRAME = 44;
/** The icon-only chip's ⌄. */
const ICON_CARET = 14;
const DISABLED_OPACITY = 0.4;
const MENU_GAP = 6;
const ROW = 44;
const OPEN_MS = 150;
/** FinalMotion "Small modals": fade in from 96% scale. */
const OPEN = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.96 }] },
  100: { opacity: 1, transform: [{ scale: 1 }] },
}).duration(OPEN_MS);

const HIDDEN = {
  accessible: false,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;

export interface InlineChoiceChipProps<T extends string | number> {
  readonly options: readonly T[];
  readonly value: T;
  /** The pill's and the menu row's visible text ("24h"). */
  readonly labelOf: (option: T) => string;
  /** The spoken name ("Stories from the last 24 hours"). */
  readonly a11yLabelOf: (option: T) => string;
  readonly onChange: (next: T) => void;
  readonly disabled?: boolean;
  /** Chip: `${testID}-toggle`; menu: `${testID}-options`; rows: `${testID}-${option}`. */
  readonly testID: string;
  /** An option's glyph. Given, the chip shows ONLY the chosen option's glyph
   *  and the ⌄ (a GitHub-style view picker: the Feed's View chip), with a
   *  round glass fill while pressed or open, and each menu row leads with its
   *  glyph. */
  readonly iconOf?: (option: T) => keyof typeof MaterialIcons.glyphMap;
  /** A small muted title over the menu's rows ("View"). */
  readonly menuTitle?: string;
  /** Which chip edge the menu hangs from: `trailing` (default; World's time
   *  chip at the row's end) or `leading` (the Feed's View chip at the row's
   *  start). Mirrored in RTL. */
  readonly menuAlign?: 'leading' | 'trailing';
}

/** A floating menu's surface: the same material as every modal and bottom
 *  sheet (ModalMaterial in a clipped container with the theme's edge). The
 *  caller positions it and gives it its shadow. */
export function ChoiceMenuPanel({ children }: { readonly children: React.ReactNode }) {
  const colors = useColors();
  return (
    <View style={[styles.clip, { borderColor: colors.line }]}>
      <ModalMaterial />
      {children}
    </View>
  );
}

interface Anchor {
  /** The chip's own top and height in the window. */
  readonly chipTop: number;
  readonly chipHeight: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
}

export default function InlineChoiceChip<T extends string | number>({
  options,
  value,
  labelOf,
  a11yLabelOf,
  onChange,
  disabled = false,
  testID,
  iconOf,
  menuTitle,
  menuAlign = 'trailing',
}: InlineChoiceChipProps<T>) {
  const colors = useColors();
  const liteMode = useDisplayPrefsStore((s) => s.liteMode);
  const still = useReducedMotion() || liteMode;
  const window = useWindowDimensions();
  const chipRef = useRef<View>(null);
  const insets = useSafeAreaInsets();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  // Measured once per open by a hidden first pass, then placed: under the
  // chip, or above it when it does not fit (menu-placement.ts).
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const rtl = I18nManager.isRTL;

  const open = useCallback(() => {
    chipRef.current?.measureInWindow((x, y, width, height) => {
      setPanelHeight(null);
      setAnchor({
        chipTop: y,
        chipHeight: height,
        left: x,
        right: window.width - (x + width),
        width,
      });
    });
  }, [window.width]);
  const close = useCallback(() => setAnchor(null), []);

  const rows = (live: boolean) =>
    options.map((option) => {
      const picked = option === value;
      return (
        <Pressable
          key={String(option)}
          onPress={() => {
            close();
            if (!picked) {
              void hapticSelection();
              onChange(option);
            }
          }}
          accessibilityRole="menuitem"
          accessibilityLabel={a11yLabelOf(option)}
          accessibilityState={{ checked: picked }}
          testID={live ? `${testID}-${option}` : undefined}
          style={styles.row}
        >
          <View style={styles.check} {...HIDDEN}>
            {picked ? <MaterialIcons name="check" size={18} color={colors.accentMark} /> : null}
          </View>
          {iconOf ? (
            <MaterialIcons name={iconOf(option)} size={18} color={colors.ink2} {...HIDDEN} />
          ) : null}
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={1}
            style={[styles.rowLabel, { color: colors.ink, fontWeight: picked ? '600' : '400' }]}
            {...HIDDEN}
          >
            {labelOf(option)}
          </Text>
        </Pressable>
      );
    });
  const panel = (live: boolean) => (
    <ChoiceMenuPanel>
      {menuTitle ? (
        <Text
          maxFontSizeMultiplier={1}
          style={[styles.menuTitle, { color: colors.muted }]}
          accessibilityRole="header"
          {...(live ? null : HIDDEN)}
        >
          {menuTitle}
        </Text>
      ) : null}
      {rows(live)}
    </ChoiceMenuPanel>
  );
  const [pressed, setPressed] = useState(false);
  // Hangs from the chip's trailing edge (the right in LTR, the left in RTL),
  // or its leading edge with `menuAlign="leading"`.
  const fromLeft = (menuAlign === 'leading') !== rtl;
  const side = anchor ? (fromLeft ? { left: anchor.left } : { right: anchor.right }) : null;

  return (
    <View style={[styles.frame, disabled ? styles.disabled : null]} testID={`${testID}-frame`}>
      <View ref={chipRef} collapsable={false} pointerEvents="none" {...HIDDEN}>
        <View
          style={
            iconOf
              ? [
                  styles.iconPill,
                  // Glass only while pressed or open (the view-picker look).
                  pressed || anchor ? { backgroundColor: colors.glass, borderColor: colors.trackBorder } : null,
                ]
              : [styles.pill, { backgroundColor: colors.glass, borderColor: colors.trackBorder }]
          }
        >
          {iconOf ? (
            <MaterialIcons name={iconOf(value)} size={20} color={colors.ink} />
          ) : (
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={1}
              style={[styles.label, { color: colors.ink, fontWeight: '600' }]}
            >
              {labelOf(value)}
            </Text>
          )}
          <MaterialIcons
            name={anchor ? 'expand-less' : 'expand-more'}
            size={iconOf ? ICON_CARET : 16}
            color={colors.muted}
          />
        </View>
      </View>
      <Pressable
        onPress={open}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        disabled={disabled}
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={a11yLabelOf(value)}
        accessibilityState={{ expanded: anchor !== null, disabled }}
        testID={`${testID}-toggle`}
      />

      <Modal visible={anchor !== null} transparent animationType="none" onRequestClose={close}>
        {/* Undimmed: a tap anywhere outside the panel closes the menu. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={close}
          accessible={false}
          testID={`${testID}-outside`}
        />
        {anchor && panelHeight === null ? (
          // The measuring pass: same panel, invisible and inert.
          <View
            pointerEvents="none"
            {...HIDDEN}
            style={[styles.panel, styles.measuring, { top: 0, minWidth: anchor.width }, side]}
            onLayout={(e) => setPanelHeight(e.nativeEvent.layout.height)}
          >
            {panel(false)}
          </View>
        ) : null}
        {anchor && panelHeight !== null ? (
          <Animated.View
            entering={still ? FadeIn.duration(OPEN_MS) : OPEN}
            accessibilityRole="menu"
            accessibilityViewIsModal
            onAccessibilityEscape={close}
            testID={`${testID}-options`}
            style={[
              styles.panel,
              {
                top: menuTop({
                  chipTop: anchor.chipTop,
                  chipHeight: anchor.chipHeight,
                  panelHeight,
                  windowHeight: window.height,
                  safeTop: insets.top,
                  safeBottom: insets.bottom,
                  gap: MENU_GAP,
                }),
                minWidth: anchor.width,
              },
              side,
            ]}
          >
            {panel(true)}
          </Animated.View>
        ) : null}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { height: FRAME, marginVertical: -(FRAME - PILL) / 2, justifyContent: 'center' },
  disabled: { opacity: DISABLED_OPACITY },
  // Board .wchip: 13pt in a fixed 34pt pill.
  label: { fontSize: 13, lineHeight: 16 },
  pill: {
    height: PILL,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingLeft: 12,
    paddingRight: 8,
  },
  // The material brings no shadow of its own (BottomSheet adds one too).
  panel: {
    position: 'absolute',
    borderRadius: 14,
    shadowColor: '#000000',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  measuring: { opacity: 0 },
  clip: { borderRadius: 14, borderWidth: 1, overflow: 'hidden', paddingVertical: 4 },
  row: {
    minHeight: ROW,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 10,
    paddingRight: 16,
    gap: 6,
  },
  check: { width: 20, alignItems: 'center' },
  // The icon-only chip: a round 34pt glyph + ⌄, the glass only while pressed
  // or open; the 44pt frame around it is the target. 44pt wide in all
  // (1 + 5 + 20 + 14 + 3 + 1): it fills the header's 44pt side slot, and its
  // glyphs do not scale with text size.
  iconPill: {
    height: PILL,
    minWidth: PILL,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'transparent',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 5,
    paddingRight: 3,
  },
  menuTitle: { fontSize: 12, lineHeight: 16, fontWeight: '600', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  rowLabel: { fontSize: 15, lineHeight: 20 },
});
