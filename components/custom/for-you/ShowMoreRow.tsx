// DEPRECATE(r5-dashboard-redesign): orphan — superseded by SectionViewAllRow
// (Dashboard section "View all N stories" footer). Delete after the redesign is
// verified live.
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

interface ShowMoreRowProps {
  remaining: number;
  onPress: () => void;
}

/**
 * Inline "Show N more" row at the tail of a section that has more than the
 * rendered top-N story groups (Wave 7c N2). Expanding is tracked per section
 * key in the screen's state so it survives re-render and resets on refresh.
 */
const ShowMoreRow: React.FC<ShowMoreRowProps> = ({ remaining, onPress }) => {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="mb-4 self-start rounded-full border border-gray-700 px-4 py-2"
    >
      <HStack className="items-center" space="xs">
        <Text size="sm" style={{ color: ACCENT, fontWeight: '600' }}>
          {t('forYou.showMore', { count: remaining })}
        </Text>
        <MaterialIcons name="expand-more" size={16} color={ACCENT} />
      </HStack>
    </Pressable>
  );
};

export default ShowMoreRow;
