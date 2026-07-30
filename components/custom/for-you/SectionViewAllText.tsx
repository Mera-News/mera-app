import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

/** Same ink as the section title — this row is a quiet continuation of the
 *  section, not a second call-to-action competing with the header pill. */
const TITLE_COLOR = '#FFFFFF';

interface SectionViewAllTextProps {
  /** Total articles in the section. */
  total: number;
  onPress: () => void;
}

/**
 * The closing row of a Dashboard section: right-aligned "View all N articles" +
 * chevron, in the section title's own type style. Lives INSIDE the section's
 * gradient panel as its last row.
 *
 * Deliberately NOT a pill. The header already carries one ("N Articles"), and
 * repeating an identical pill at the bottom read as a second, different
 * destination when both go to the same fact feed. Plain text keeps one obvious
 * primary affordance per section while still closing it off legibly.
 */
const SectionViewAllText: React.FC<SectionViewAllTextProps> = ({ total, onPress }) => {
  const { t } = useTranslation();
  const label = t('forYou.viewAllArticles', { count: total });
  return (
    <Pressable
      testID="dashboard-view-all"
      onPress={onPress}
      accessibilityRole="button"
      // Spoken label equals the visible text, count included.
      accessibilityLabel={label}
      hitSlop={8}
      className="self-end px-3 pb-3 pt-1"
    >
      <HStack className="items-center" space="xs">
        <Text size="lg" bold style={{ color: TITLE_COLOR }} numberOfLines={1}>
          {label}
        </Text>
        <MaterialIcons name="chevron-right" size={20} color={TITLE_COLOR} />
      </HStack>
    </Pressable>
  );
};

export default SectionViewAllText;
