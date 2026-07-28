import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

interface SectionStoriesPillProps {
  /** Total stories in the section. */
  total: number;
  onPress: () => void;
  /** Distinguishes the two placements for the driver only — both render
   *  IDENTICALLY by design. */
  testID?: string;
}

/**
 * "N stories" — the pill that opens a Dashboard section's full fact feed.
 *
 * Rendered in TWO places per section, deliberately pixel-identical: in the
 * section header (right-aligned, the fact text wrapping to its left) and at the
 * bottom of the section. One component, so they cannot drift apart: the CTA
 * story is "you are looking at a section; open the full panel", and two
 * differently-styled buttons doing the same thing muddies that.
 *
 * Copy is the bare count ("12 stories") rather than the old "View all 12
 * stories": the verb was carried by the pill affordance already, and the shorter
 * label is what lets it sit inline in the header without crowding the title.
 */
const SectionStoriesPill: React.FC<SectionStoriesPillProps> = ({ total, onPress, testID }) => {
  const { t } = useTranslation();
  return (
    <Pressable
      testID={testID ?? 'dashboard-view-all'}
      onPress={onPress}
      accessibilityRole="button"
      // Spoken label matches the visible text (Apple's rule) instead of the old
      // generic "See all stories for this topic", which dropped the count and
      // read identically on every section.
      accessibilityLabel={t('forYou.storiesCount', { count: total })}
      hitSlop={6}
      className="flex-shrink-0 rounded-full border px-3 py-1"
      style={{ borderColor: ACCENT, borderWidth: 1.25 }}
    >
      <HStack className="items-center" space="xs">
        <Text size="sm" style={{ color: ACCENT, fontWeight: '600' }} numberOfLines={1}>
          {t('forYou.storiesCount', { count: total })}
        </Text>
        <MaterialIcons name="chevron-right" size={16} color={ACCENT} />
      </HStack>
    </Pressable>
  );
};

export default SectionStoriesPill;
