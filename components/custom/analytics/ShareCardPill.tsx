// ShareCardPill — the share control at the end of each Analytics section.
//
// A CONTROL, not a moment. No reward animation, no flourish, one light haptic
// on press. Sharing is something the reader chose to do; celebrating it would
// be the app congratulating itself.
//
// ## It scrolls with the content, deliberately
//
// A pinned pill is reachable without scrolling, but it costs vertical space on
// every section including the one carrying a 190pt grid, and on a 3 GB floor
// device that is not free. It would also need a scrim or it collides with what
// passes behind it. A pill at the END of a section is also honest about where
// that card stops: the reader shares the thing they have just finished reading.
//
// ## Clearance is a floor, not a target
//
// `TAB_BAR_HEIGHT` is a conservative ESTIMATE (49 iOS / 56 Android), not the
// rendered height: the native bar owns its own height and does not expose it to
// JS. So the last section adds the safe-area inset on top of it and then some,
// rather than sitting exactly on the number.
//
// ## The haptic is resolved inside the handler
//
// Never at module scope. Expo Router eagerly imports every route subtree at JS
// boot, so a module-scope `import * as Haptics from 'expo-haptics'` is
// evaluated before anything renders, and on a client whose BINARY lacks the
// module it throws and the WHOLE APP fails to start. A resolution failure here
// just means no haptic.

import { CARD_ACCENT } from '@/components/custom/share-stats/card-theme';
import { Text } from '@/components/ui/text';
import React, { useCallback } from 'react';
import { Pressable, View } from 'react-native';

export const PILL_METRICS = {
  height: 44,
  radius: 22,
  paddingX: 22,
  label: 15,
  marginTop: 18,
} as const;

interface Props {
  readonly label: string;
  readonly onPress: () => void;
  readonly testID: string;
  readonly disabled?: boolean;
}

const ShareCardPill: React.FC<Props> = ({ label, onPress, testID, disabled = false }) => {
  const handlePress = useCallback(() => {
    void (async () => {
      try {
        const Haptics = await import('expo-haptics');
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } catch {
        // No haptic module in this binary, or the device has no taptic engine.
        // The share still happens; a missing haptic is not a failure.
      }
    })();
    onPress();
  }, [onPress]);

  return (
    <View style={{ alignItems: 'center', marginTop: PILL_METRICS.marginTop }}>
      <Pressable
        testID={testID}
        onPress={handlePress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        style={{
          height: PILL_METRICS.height,
          borderRadius: PILL_METRICS.radius,
          paddingHorizontal: PILL_METRICS.paddingX,
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: CARD_ACCENT,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Text
          className="font-semibold"
          style={{ fontSize: PILL_METRICS.label, lineHeight: Math.ceil(PILL_METRICS.label * 1.4), color: CARD_ACCENT }}
        >
          {label}
        </Text>
      </Pressable>
    </View>
  );
};

export default ShareCardPill;
