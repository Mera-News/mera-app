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
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useRef, useState } from 'react';
import { I18nManager, Modal, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, Keyframe, useReducedMotion } from 'react-native-reanimated';

const PILL = 34;
const FRAME = 44;
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
  readonly top: number;
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
}: InlineChoiceChipProps<T>) {
  const colors = useColors();
  const liteMode = useDisplayPrefsStore((s) => s.liteMode);
  const still = useReducedMotion() || liteMode;
  const window = useWindowDimensions();
  const chipRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const rtl = I18nManager.isRTL;

  const open = useCallback(() => {
    chipRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ top: y + height + MENU_GAP, left: x, right: window.width - (x + width), width });
    });
  }, [window.width]);
  const close = useCallback(() => setAnchor(null), []);

  return (
    <View style={[styles.frame, disabled ? styles.disabled : null]} testID={`${testID}-frame`}>
      <View ref={chipRef} collapsable={false} pointerEvents="none" {...HIDDEN}>
        <View
          style={[styles.pill, { backgroundColor: colors.glass, borderColor: colors.trackBorder }]}
        >
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={1}
            style={[styles.label, { color: colors.ink, fontWeight: '600' }]}
          >
            {labelOf(value)}
          </Text>
          <MaterialIcons
            name={anchor ? 'expand-less' : 'expand-more'}
            size={16}
            color={colors.muted}
          />
        </View>
      </View>
      <Pressable
        onPress={open}
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
        {anchor ? (
          <Animated.View
            entering={still ? FadeIn.duration(OPEN_MS) : OPEN}
            accessibilityRole="menu"
            accessibilityViewIsModal
            onAccessibilityEscape={close}
            testID={`${testID}-options`}
            style={[
              styles.panel,
              { top: anchor.top, minWidth: anchor.width },
              // Hangs from the chip's trailing edge: the right in LTR, the left in RTL.
              rtl ? { left: anchor.left } : { right: anchor.right },
            ]}
          >
            <ChoiceMenuPanel>
              {options.map((option) => {
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
                    testID={`${testID}-${option}`}
                    style={styles.row}
                  >
                    <View style={styles.check} {...HIDDEN}>
                      {picked ? (
                        <MaterialIcons name="check" size={18} color={colors.accentMark} />
                      ) : null}
                    </View>
                    <Text
                      numberOfLines={1}
                      maxFontSizeMultiplier={1}
                      style={[
                        styles.rowLabel,
                        { color: colors.ink, fontWeight: picked ? '600' : '400' },
                      ]}
                      {...HIDDEN}
                    >
                      {labelOf(option)}
                    </Text>
                  </Pressable>
                );
              })}
            </ChoiceMenuPanel>
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
  rowLabel: { fontSize: 15, lineHeight: 20 },
});
