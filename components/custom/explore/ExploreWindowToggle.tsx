// The Explore header's 24h/48h switch: which stories the scope lists keep, by
// when the story FIRST appeared anywhere (the server's `windowHours`). A text
// pill, so it reads as a state, not an action icon.
//
// Same accessibility shape as HeaderIconButton: the visual is a hidden layer
// and a CHILDLESS labelled Pressable sits over it, so iOS exposes one button
// with our label rather than the pill's text as a separate StaticText. A 44pt
// tall frame pulled back by negative margins keeps the title row's height.
// STATIC styles only (the css-interop wrapper drops function styles on device).

import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

export type ExploreWindowHours = 24 | 48;

const TARGET = 44;
const PILL_HEIGHT = 28;
const FRAME_STYLE = {
  height: TARGET,
  marginVertical: -(TARGET - PILL_HEIGHT) / 2,
  justifyContent: 'center',
} as const;
const PILL_STYLE = {
  height: PILL_HEIGHT,
  paddingHorizontal: 10,
  borderRadius: PILL_HEIGHT / 2,
  borderWidth: 1,
  borderColor: 'rgba(255,255,255,0.6)',
  alignItems: 'center',
  justifyContent: 'center',
} as const;

export interface ExploreWindowToggleProps {
  readonly value: ExploreWindowHours;
  readonly onChange: (next: ExploreWindowHours) => void;
}

export default function ExploreWindowToggle({ value, onChange }: ExploreWindowToggleProps) {
  const { t } = useTranslation();
  const is24 = value === 24;
  return (
    <View style={FRAME_STYLE} testID="explore-window-toggle-frame">
      <View
        pointerEvents="none"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={PILL_STYLE}
      >
        <Text size="sm" className="text-white font-semibold" numberOfLines={1}>
          {is24 ? t('explore.window.label24') : t('explore.window.label48')}
        </Text>
      </View>
      <Pressable
        onPress={() => onChange(is24 ? 48 : 24)}
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={is24 ? t('explore.window.a11y24') : t('explore.window.a11y48')}
        accessibilityHint={is24 ? t('explore.window.hint24') : t('explore.window.hint48')}
        testID="explore-window-toggle"
      />
    </View>
  );
}
