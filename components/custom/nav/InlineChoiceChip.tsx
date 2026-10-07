// One expanding choice chip: World's time chip and the Feed's View chip.
// Collapsed, a 34pt glass pill "‹ 24h". Tapped, it grows from its trailing
// edge into every option (the picked one orange); a pick closes it. The row
// never changes height, so the list under it never moves.
//
//  - Each pill draws 34pt inside a 44pt frame given back by negative margins
//    (never hitSlop: QA measures a hitSlop target as its glyph box).
//  - Hidden visual under a CHILDLESS labelled button: a glyph inside a button
//    surfaces on iOS as its own StaticText.
//  - Open state is local, so the host list never re-renders for it.
//  - Options fade in on the UI thread; still under Reduce Motion or Lite mode.

import { GlassPanel } from '@/components/custom/GlassSurface';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { I18nManager, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';

import { COLORS, useColors } from '@/lib/theme/tokens';

const PILL = 34;
const FRAME = 44;
const OPTION_GAP = 6;
const OPTION_FADE_MS = 150;
const DISABLED_OPACITY = 0.4;

const HIDDEN = {
  accessible: false,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;

export interface InlineChoiceChipProps<T extends string | number> {
  readonly options: readonly T[];
  readonly value: T;
  /** The pill's visible text ("24h"). */
  readonly labelOf: (option: T) => string;
  /** The spoken name ("Stories from the last 24 hours"). */
  readonly a11yLabelOf: (option: T) => string;
  readonly onChange: (next: T) => void;
  readonly disabled?: boolean;
  /** Collapsed: `${testID}-toggle`; options: `${testID}-${option}`. */
  readonly testID: string;
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
  const [open, setOpen] = useState(false);
  const colors = useColors();
  const liteMode = useDisplayPrefsStore((s) => s.liteMode);
  const still = useReducedMotion() || liteMode;

  if (!open) {
    return (
      <View style={[styles.frame, disabled ? styles.disabled : null]} testID={`${testID}-frame`}>
        <View pointerEvents="none" {...HIDDEN}>
          <GlassPanel radius={999}>
            <View style={[styles.pill, styles.collapsed]}>
              <MaterialIcons
                name={I18nManager.isRTL ? 'chevron-right' : 'chevron-left'}
                size={14}
                color={colors.muted}
              />
              <Text size="sm" scaleTier="chrome" numberOfLines={1} className="text-white font-semibold">
                {labelOf(value)}
              </Text>
            </View>
          </GlassPanel>
        </View>
        <Pressable
          onPress={() => setOpen(true)}
          disabled={disabled}
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel={a11yLabelOf(value)}
          accessibilityState={{ expanded: false, disabled }}
          testID={`${testID}-toggle`}
        />
      </View>
    );
  }

  return (
    <View style={styles.options} testID={`${testID}-options`}>
      {options.map((option) => {
        const picked = option === value;
        const label = (
          <Text
            size="sm"
            scaleTier="chrome"
            numberOfLines={1}
            style={{ color: picked ? colors.onAccent : colors.muted }}
            className={picked ? 'font-semibold' : undefined}
          >
            {labelOf(option)}
          </Text>
        );
        return (
          <Animated.View
            key={String(option)}
            entering={still ? undefined : FadeIn.duration(OPTION_FADE_MS)}
            style={styles.frame}
          >
            <View pointerEvents="none" {...HIDDEN}>
              {picked ? (
                <View style={[styles.pill, styles.option, styles.picked]}>{label}</View>
              ) : (
                <GlassPanel radius={999}>
                  <View style={[styles.pill, styles.option]}>{label}</View>
                </GlassPanel>
              )}
            </View>
            <Pressable
              onPress={() => {
                setOpen(false);
                if (!picked) onChange(option);
              }}
              style={StyleSheet.absoluteFill}
              accessibilityRole="button"
              accessibilityLabel={a11yLabelOf(option)}
              accessibilityState={{ selected: picked }}
              testID={`${testID}-${option}`}
            />
          </Animated.View>
        );
      })}
    </View>
  );
}

// P12 moves these onto useColors().
const C = COLORS.dark;

const styles = StyleSheet.create({
  frame: { height: FRAME, marginVertical: -(FRAME - PILL) / 2, justifyContent: 'center' },
  disabled: { opacity: DISABLED_OPACITY },
  pill: {
    height: PILL,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.trackBorder,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  collapsed: { gap: 4, paddingLeft: 10, paddingRight: 12 },
  option: { minWidth: FRAME, paddingHorizontal: 10 },
  picked: { backgroundColor: C.accent, borderColor: C.accent },
  options: { flexDirection: 'row', alignItems: 'center', gap: OPTION_GAP },
});
