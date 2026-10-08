// A page's name at the top of its OWN list, with a ? that opens the page's
// explainer and an optional trailing control (World's time chip, the Feed's
// View chip). It is always INSIDE the list's ListHeaderComponent, never a
// sibling before the list: react-native-screens walks `subviews[0]` to find
// the tab's scroll view.
//
// The ? is a 24pt ring in a 44pt frame given back by negative margins (never
// hitSlop), a hidden visual under a childless labelled button.

import { markHelpOrigin } from '@/components/ui/help-modal';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { useColors } from '@/lib/theme/tokens';

const RING = 24;
const FRAME = 44;

export interface PageTitleRowProps {
  readonly title: string;
  /** Opens the page's explainer. Absent: no ?. */
  readonly onExplain?: () => void;
  readonly trailing?: React.ReactNode;
  readonly testID?: string;
}

const PageTitleRow: React.FC<PageTitleRowProps> = ({ title, onExplain, trailing, testID }) => {
  const { t } = useTranslation();
  const colors = useColors();
  return (
    <View style={styles.row} testID={testID}>
      <Text
        size="lg"
        bold
        numberOfLines={1}
        accessibilityRole="header"
        // Larger Text may grow the page title a little, never past 1.2x.
        maxFontSizeMultiplier={1.2}
        style={[styles.title, { color: colors.ink }]}
      >
        {title}
      </Text>
      {onExplain ? (
        <View style={styles.helpFrame} testID={testID ? `${testID}-help-frame` : undefined}>
          <View
            pointerEvents="none"
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.ring, { borderColor: colors.helpRing }]}
          >
            <Text style={[styles.q, { color: colors.muted }]}>?</Text>
          </View>
          <Pressable
            onPress={(e) => { markHelpOrigin(e.currentTarget); onExplain(); }}
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel={t('nav.explainerA11y', { page: title })}
            testID={testID ? `${testID}-help` : undefined}
          />
        </View>
      ) : null}
      <View style={styles.spacer} />
      {trailing}
    </View>
  );
};

const styles = StyleSheet.create({
  // Frames inside the row give their height back, so the row is the title's.
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 34 },
  // 17/22 bold, set together (a fontSize without its lineHeight clips).
  title: { fontSize: 17, lineHeight: 22, flexShrink: 1 },
  helpFrame: {
    width: FRAME,
    height: FRAME,
    marginVertical: -(FRAME - RING) / 2,
    marginLeft: -4,
    marginRight: -6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  q: { fontSize: 13, lineHeight: 16, fontWeight: '700' },
  spacer: { flex: 1 },
});

export default PageTitleRow;
