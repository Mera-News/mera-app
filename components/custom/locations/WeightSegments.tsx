import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { WEIGHT_BUCKETS, type WeightBucket } from './location-display';

interface Props {
  readonly value: WeightBucket;
  readonly onChange: (bucket: WeightBucket) => void;
  /** Compact variant for inline list rows. */
  readonly compact?: boolean;
}

/**
 * 3-step segmented control (Low / Medium / High) — the weight control for both
 * the add-flow and the list rows. Each tap is a discrete commit (weight edits
 * are change-logged on selection, never continuously).
 */
const WeightSegments: React.FC<Props> = ({ value, onChange, compact = false }) => {
  const { t } = useTranslation();
  const pad = compact ? 'py-1' : 'py-2';
  const textSize = compact ? 'text-xs' : 'text-sm';
  return (
    <View className="flex-row rounded-full border border-gray-700 overflow-hidden">
      {WEIGHT_BUCKETS.map((b, i) => {
        const selected = b.bucket === value;
        return (
          <Pressable
            key={b.bucket}
            onPress={() => onChange(b.bucket)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={t(`locations.weight.${b.bucket}` as never)}
            className={`flex-1 items-center ${pad} ${selected ? 'bg-primary-500' : 'bg-transparent'} ${
              i > 0 ? 'border-l border-gray-700' : ''
            }`}
          >
            <Text
              className={`${textSize} ${selected ? 'text-black font-semibold' : 'text-gray-300'}`}
            >
              {t(`locations.weight.${b.bucket}` as never)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
};

export default WeightSegments;
