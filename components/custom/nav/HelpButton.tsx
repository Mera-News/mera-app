// The header's small ring buttons: a 24pt ring in a 44pt frame, a hidden
// visual under a childless labelled button. `HelpButton` is the ? that opens
// a page's explainer (it marks itself as the help card's origin, so the card
// grows out of it); `RingButton` with a glyph is the same control for others
// (World's search), so the two read as one set.

import { markHelpOrigin } from '@/components/ui/help-modal';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useColors } from '@/lib/theme/tokens';

const RING = 24;
export const HELP_FRAME = 44;

export interface HelpButtonProps {
  readonly onPress: () => void;
  /** Spoken name, e.g. "About Saved". */
  readonly label: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}

export interface RingButtonProps extends HelpButtonProps {
  /** A glyph in the ring; absent: the ?. */
  readonly icon?: React.ComponentProps<typeof MaterialIcons>['name'];
  readonly beforePress?: (target: Parameters<typeof markHelpOrigin>[0]) => void;
}

const HelpButton: React.FC<HelpButtonProps> = (props) => (
  <RingButton {...props} beforePress={(target) => markHelpOrigin(target)} />
);

export const RingButton: React.FC<RingButtonProps> = ({ onPress, beforePress, label, icon, style, testID }) => {
  const colors = useColors();
  return (
    <View style={[styles.frame, style]} testID={testID ? `${testID}-frame` : undefined}>
      <View
        pointerEvents="none"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.ring, { borderColor: colors.helpRing }]}
      >
        {icon ? (
          <MaterialIcons name={icon} size={15} color={colors.muted} />
        ) : (
          <Text style={[styles.q, { color: colors.muted }]}>?</Text>
        )}
      </View>
      <Pressable
        onPress={(e) => {
          beforePress?.(e.currentTarget);
          onPress();
        }}
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={label}
        testID={testID}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  frame: { width: HELP_FRAME, height: HELP_FRAME, alignItems: 'center', justifyContent: 'center' },
  ring: {
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  q: { fontSize: 13, lineHeight: 16, fontWeight: '700' },
});

export default HelpButton;
