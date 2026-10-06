// The Explore header's time window: the scope lists rank the stories most
// covered in the last 6, 12, 24 or 48 hours (the server's `windowHours`). A text
// pill that opens a menu, so it reads as a state, not an action icon.
//
// Same accessibility shape as HeaderIconButton: the visual is a hidden layer
// and a CHILDLESS labelled Pressable sits over it, so iOS exposes one button
// with our label rather than the pill's text as a separate StaticText. A 44pt
// tall frame pulled back by negative margins keeps the title row's height.
// STATIC styles only (the css-interop wrapper drops function styles on device).
//
// The menu is built like RelatedSortDropdown's: selection on each item's own
// onPress (the aria selection layer never fires on native), controlled open
// state for VoiceOver's escape gesture, and a native modal so VoiceOver can
// reach the items.

import { CheckIcon, Icon } from '@/components/ui/icon';
import { Menu, MenuItem, MenuItemLabel } from '@/components/ui/menu';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

export const EXPLORE_WINDOWS_HOURS = [6, 12, 24, 48] as const;
export type ExploreWindowHours = (typeof EXPLORE_WINDOWS_HOURS)[number];

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
  const [open, setOpen] = useState(false);
  const openMenu = useCallback(() => setOpen(true), []);
  const closeMenu = useCallback(() => setOpen(false), []);

  return (
    <Menu
      placement="bottom right"
      offset={6}
      closeOnSelect
      isOpen={open}
      onOpen={openMenu}
      onClose={closeMenu}
      useRNModal
      onAccessibilityEscape={closeMenu}
      trigger={(triggerProps) => (
        <View style={FRAME_STYLE} testID="explore-window-toggle-frame">
          <View
            pointerEvents="none"
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={PILL_STYLE}
          >
            <Text size="sm" className="text-white font-semibold" numberOfLines={1}>
              {t(`explore.window.label${value}` as any)}
            </Text>
          </View>
          <Pressable
            {...triggerProps}
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel={t('explore.window.menuLabel')}
            accessibilityValue={{ text: t(`explore.window.a11y${value}` as any) }}
            testID="explore-window-toggle"
          />
        </View>
      )}
    >
      {EXPLORE_WINDOWS_HOURS.map((hours) => {
        const selected = hours === value;
        return (
          <MenuItem
            key={hours}
            textValue={t(`explore.window.option${hours}` as any)}
            testID={`explore-window-${hours}`}
            onPress={() => onChange(hours)}
            className="min-w-36 p-2.5"
          >
            <MenuItemLabel size="sm" className={selected ? 'text-primary-400 font-semibold' : ''}>
              {t(`explore.window.option${hours}` as any)}
            </MenuItemLabel>
            {/* Fixed-width slot so labels align checked or not */}
            <View style={{ width: 24, alignItems: 'flex-end' }}>
              {selected && <Icon as={CheckIcon} size="sm" className="text-primary-400" />}
            </View>
          </MenuItem>
        );
      })}
    </Menu>
  );
}
