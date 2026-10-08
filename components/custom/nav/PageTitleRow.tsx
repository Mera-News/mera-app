// A page's title at the top of its OWN list, for a title that says more than
// its pill (History, Stats, a count), with an optional trailing control. The
// page's ? is never here: it is in the tab header (PageStrip). It is always
// INSIDE the list's ListHeaderComponent, never a sibling before the list:
// react-native-screens walks `subviews[0]` to find the tab's scroll view.

import { Text } from '@/components/ui/text';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useColors } from '@/lib/theme/tokens';

export interface PageTitleRowProps {
  readonly title: string;
  readonly trailing?: React.ReactNode;
  readonly testID?: string;
}

const PageTitleRow: React.FC<PageTitleRowProps> = ({ title, trailing, testID }) => {
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
  spacer: { flex: 1 },
});

export default PageTitleRow;
