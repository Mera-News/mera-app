import { Pressable } from '@/components/ui/pressable';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

/** Visual diameter of the circular affordance. The tap target is lifted to the
 *  44pt minimum by `hitSlop` below rather than by inflating the circle, so the
 *  header's vertical rhythm is unaffected. */
const CIRCLE_SIZE = 32;
const HIT_SLOP = (44 - CIRCLE_SIZE) / 2; // 6

interface SectionOpenButtonProps {
  /** Total articles in the section — spoken, not shown (see below). */
  total: number;
  onPress: () => void;
}

/**
 * The Dashboard section header's open affordance: a round right-arrow that opens
 * the section's full fact feed.
 *
 * Replaced an "N Articles" pill. The count is NOT dropped, just moved — the
 * section's closing row (`SectionViewAllText`, "View all N articles") already
 * carries it, so showing it twice per section was redundant and crowded the
 * wrapping fact title.
 *
 * It is icon-only, so it MUST carry its own label: VoiceOver would otherwise
 * announce a bare button. The label deliberately reuses the closing row's
 * "View all N articles" string, count included — so the spoken affordance names
 * the same destination and the same number as the visible text below it, and the
 * count survives for screen-reader users even though it is no longer drawn here.
 *
 * The subtle translucent-accent fill reads against both the near-black page and
 * the section's pastel gradient, which varies per fact.
 */
const SectionOpenButton: React.FC<SectionOpenButtonProps> = ({ total, onPress }) => {
  const { t } = useTranslation();
  return (
    <Pressable
      testID="dashboard-section-open"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('forYou.viewAllArticles', { count: total })}
      hitSlop={HIT_SLOP}
      className="flex-shrink-0 items-center justify-center rounded-full"
      style={{
        width: CIRCLE_SIZE,
        height: CIRCLE_SIZE,
        backgroundColor: 'rgba(231, 138, 83, 0.14)',
      }}
    >
      <MaterialIcons name="arrow-forward" size={20} color={ACCENT} />
    </Pressable>
  );
};

export default SectionOpenButton;
