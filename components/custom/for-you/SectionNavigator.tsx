import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import React from 'react';
import { ScrollView } from 'react-native';

/**
 * One navigator chip. `translatable` picks the render path:
 *  - true  → the sectioned feed: `title` is a dynamic English section title,
 *            rendered via TranslatableDynamic (NOT a static i18n key).
 *  - false → the legacy priority-bucket layout: `title` is already a resolved
 *            UI string (the caller ran `t()`), rendered as plain Text.
 */
export type NavSection = { key: string; title: string; translatable: boolean };

/** @deprecated legacy shape kept for the pre-migration fallback path. */
export type SectionItem = { label: string; shortLabel: string };

// Cap the chip row so a persona with dozens of facts doesn't produce an
// unusable navigator; the 9th+ sections are reachable via the overflow chip.
const MAX_CHIPS = 8;

type Props = {
  sections: NavSection[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  /** Tapped when the '⋯' overflow chip is pressed (jump to the 9th section). */
  onOverflow?: () => void;
};

const SectionNavigator: React.FC<Props> = ({ sections, activeKey, onSelect, onOverflow }) => {
  if (sections.length === 0) return null;

  const capped = sections.slice(0, MAX_CHIPS);
  const hasOverflow = sections.length > MAX_CHIPS;

  const chip = (s: NavSection) => {
    const active = activeKey === s.key;
    return (
      <Pressable
        key={s.key}
        onPress={() => onSelect(s.key)}
        className={`mr-2 items-center py-2 px-4 rounded-full border ${active ? 'border-orange-500' : 'border-gray-700'}`}
      >
        {s.translatable ? (
          <TranslatableDynamic
            text={s.title}
            size="sm"
            numberOfLines={1}
            className={`font-medium ${active ? 'text-orange-500' : 'text-gray-500'}`}
            style={{ maxWidth: 160 }}
          />
        ) : (
          <Text
            size="sm"
            numberOfLines={1}
            className={`font-medium ${active ? 'text-orange-500' : 'text-gray-500'}`}
          >
            {s.title}
          </Text>
        )}
      </Pressable>
    );
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 4 }}
    >
      {capped.map(chip)}
      {hasOverflow && (
        <Pressable
          key="__overflow__"
          onPress={() => onOverflow?.()}
          accessibilityRole="button"
          className="mr-2 items-center py-2 px-4 rounded-full border border-gray-700"
        >
          <Text size="sm" className="font-medium text-gray-500">
            ⋯
          </Text>
        </Pressable>
      )}
    </ScrollView>
  );
};

export default SectionNavigator;
