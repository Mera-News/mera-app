// The bolt-badged sliders button on Feed, Interests and Checks: it jumps to
// the setting where it already lives on the You tab, highlighted
// (navigateToSetting, lib/navigation/focus-target.ts). The bolt says
// "shortcut", not "settings screen".
//
// A childless labelled button over a hidden visual: a glyph inside a button
// surfaces on iOS as its own StaticText.

import { Pressable } from '@/components/ui/pressable';
import { navigateToSetting } from '@/lib/navigation/focus-target';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { QuickSettingsFocusId } from './page-registry';

export const NAV_ACCENT = '#E78A53';
/** The header's colour, for the badge's ring. */
const HEADER_INK = '#121113';

export interface QuickSettingsButtonProps {
  readonly targets: readonly QuickSettingsFocusId[];
  /** The page's label, for "Quick settings for Feed". */
  readonly pageLabel: string;
}

const QuickSettingsButton: React.FC<QuickSettingsButtonProps> = ({ targets, pageLabel }) => {
  const { t } = useTranslation();
  return (
    <View style={styles.frame} testID="quick-settings-frame">
      <View
        style={styles.glyph}
        pointerEvents="none"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <MaterialIcons name="tune" size={22} color="#FFFFFF" />
        <View style={styles.badge} testID="quick-settings-bolt">
          <MaterialIcons name="bolt" size={9} color={HEADER_INK} />
        </View>
      </View>
      <Pressable
        onPress={() => navigateToSetting(targets)}
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={t('nav.quickSettingsA11y', { page: pageLabel })}
        testID="quick-settings"
      />
    </View>
  );
};

const styles = StyleSheet.create({
  frame: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  glyph: { width: 22, height: 22 },
  badge: {
    position: 'absolute',
    // A 12pt badge with a 2pt ring in the header colour around it.
    right: -5,
    bottom: -5,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: NAV_ACCENT,
    borderWidth: 2,
    borderColor: HEADER_INK,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default QuickSettingsButton;
