// The small bubble a filled bookmark opens: Archive (Read later for an archived
// article) and Remove. A tap outside, Android back or VoiceOver's escape closes
// it and changes nothing.
//
// An RN Modal, undimmed like InlineChoiceChip's menu: it must clear the card's
// clip and the tab bar without moving the row. Not gluestack's Popover: its
// content hard-codes `accessible`, so VoiceOver would read both actions as one
// element.
//
// Placed from the bookmark's measured box and the panel's own measured size, so
// large text and the screen's ends need no case here. The panel centres in a
// full-width box and moves by transform: RTL swaps `left`, never a transform.

import ModalMaterial from '@/components/custom/ModalMaterial';
import { menuTop } from '@/components/custom/nav/menu-placement';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useRestartHold } from '@/lib/app-restart';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ArchiveMenuItem } from './use-archive-menu-item';

const GAP = 6;
/** The bubble's least distance from the window's sides. */
const SIDE = 12;
const OPEN_MS = 150;

const HIDDEN = {
  accessible: false,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;

/** The bookmark's box, in window points. */
export interface BubbleAnchor {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Props {
  readonly anchor: BubbleAnchor;
  readonly item: ArchiveMenuItem;
  readonly onRemove?: () => void;
  readonly onClose: () => void;
}

const UnsaveBubble: React.FC<Props> = ({ anchor, item, onRemove, onClose }) => {
  const { t } = useTranslation();
  const colors = useColors();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useRestartHold(true, 'overlay:sheet', 'auto');

  const move = async () => {
    onClose();
    let ok: void | boolean = undefined;
    try {
      ok = await item.run();
    } catch {
      ok = false;
    }
    if (ok === false) {
      // Required at call time, as every toast under the card graph is.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { toastManager } = require('@/lib/toast-manager') as typeof import('@/lib/toast-manager');
      toastManager.showInfo(t('articleMenu.actionFailed'));
    }
  };

  const remove = () => {
    onClose();
    onRemove?.();
  };

  const half = (size?.width ?? 0) / 2;
  const centre = Math.max(SIDE + half, Math.min(anchor.x + anchor.width / 2, window.width - SIDE - half));
  const top = menuTop({
    chipTop: anchor.y,
    chipHeight: anchor.height,
    panelHeight: size?.height ?? 0,
    windowHeight: window.height,
    safeTop: insets.top,
    safeBottom: insets.bottom,
    gap: GAP,
  });

  const row = (
    label: string,
    icon: keyof typeof MaterialIcons.glyphMap,
    onPress: () => void,
    testID: string,
  ) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="menuitem"
      accessibilityLabel={label}
      testID={testID}
      style={styles.row}
    >
      <MaterialIcons name={icon} size={18} color={colors.ink2} {...HIDDEN} />
      <Text style={[styles.label, { color: colors.ink }]} {...HIDDEN}>
        {label}
      </Text>
    </Pressable>
  );

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessible={false}
        testID="unsave-bubble-outside"
      />
      <Animated.View
        entering={FadeIn.duration(OPEN_MS)}
        pointerEvents="box-none"
        testID="unsave-bubble-box"
        style={[styles.box, { top }]}
      >
        <View
          testID="unsave-bubble"
          accessibilityRole="menu"
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
          onLayout={(e) => setSize(e.nativeEvent.layout)}
          style={[
            styles.panel,
            {
              maxWidth: window.width - 2 * SIDE,
              opacity: size ? 1 : 0,
              transform: [{ translateX: centre - window.width / 2 }],
            },
          ]}
        >
          <View style={[styles.clip, { borderColor: colors.line }]}>
            <ModalMaterial />
            {row(item.shortLabel, item.icon, () => void move(), 'unsave-bubble-move')}
            {row(t('savedSuggestions.removeShort'), 'delete-outline', remove, 'unsave-bubble-remove')}
          </View>
        </View>
      </Animated.View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  box: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  // The material brings no shadow of its own.
  panel: {
    borderRadius: 14,
    shadowColor: '#000000',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  clip: { borderRadius: 14, borderWidth: 1, overflow: 'hidden', paddingVertical: 4 },
  row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16 },
  label: { fontSize: 15, lineHeight: 20 },
});

export default UnsaveBubble;
