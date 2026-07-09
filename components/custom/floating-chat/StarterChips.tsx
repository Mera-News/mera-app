// StarterChips — a wrap of outlined tappable chips shown at the start of an
// empty thread. Presentational: fires onChipPress with the chip's message.

import { Text } from '@/components/ui/text';
import { hapticLight } from '@/lib/haptics';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { StarterChip } from './types';

const ACCENT = 'rgb(231, 138, 83)';

export interface StarterChipsProps {
  chips: StarterChip[];
  onChipPress: (message: string) => void;
}

const StarterChips: React.FC<StarterChipsProps> = ({ chips, onChipPress }) => {
  if (chips.length === 0) return null;

  return (
    <View style={styles.container}>
      {chips.map((chip) => (
        <Pressable
          key={chip.key}
          style={styles.chip}
          onPress={() => {
            hapticLight();
            onChipPress(chip.message);
          }}
        >
          <Text size="sm" style={styles.chipText}>
            {chip.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chip: {
    borderWidth: 1,
    borderColor: ACCENT,
    borderRadius: 20,
    backgroundColor: 'transparent',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipText: {
    color: ACCENT,
    // Slightly smaller than the uniform chat body (15) so chips read as chrome.
    fontSize: 13,
    lineHeight: 18,
  },
});

export default StarterChips;
