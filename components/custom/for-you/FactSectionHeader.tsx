import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import SectionOpenButton from '@/components/custom/for-you/SectionOpenButton';
import { eventTypeIcon } from '@/components/custom/for-you/event-type-icons';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

interface FactSectionHeaderProps {
  /** The fact's display title (rendered after the "News about:" prefix). */
  title: string;
  /** event_type of the row's top item — drives the icon prefix. */
  eventType: string | null;
  /** TOTAL articles in this section. Not DRAWN in the header any more — it is
   *  the accessibility label of the round open button on the right (and is shown
   *  visibly on the section's closing "View all N articles" row). */
  total: number;
  /** When set, the whole header is tappable and opens the full fact feed. */
  onPress?: () => void;
}

/**
 * Row header for the fact-rows For You feed (Round-3 C2).
 *
 * Renders a "News about:" prefix + the fact title (dynamic, so translated via
 * TranslatableDynamic), an optional event-type icon, and a round right-arrow
 * button (right-aligned; the title WRAPS to its left rather than truncating to
 * one line). Tapping the button opens the fact's full feed (`FactFeedScreen`).
 *
 * The "+N new" badge was removed: the section's total is the number that says
 * something durable about it, and "new since your last visit" was an extra
 * count competing with it for the same corner.
 */
const FactSectionHeader: React.FC<FactSectionHeaderProps> = ({
  title,
  eventType,
  total,
  onPress,
}) => {
  const { t } = useTranslation();

  const icon = eventTypeIcon(eventType);
  const canPress = !!onPress;

  const titleNode = (
    <TranslatableDynamic
      text={title}
      as="heading"
      size="lg"
      bold
      // Wraps to a second line instead of truncating — a truncated fact
      // ("Works as a software engineer buildin…") was unreadable and the full
      // text appeared nowhere else.
      numberOfLines={2}
      className="text-white"
    />
  );

  const HeaderInner = (
    // Internal padding (no outer margins) so the header text sits on the
    // gradient ink of the enclosing SectionGradientPanel.
    <VStack className="px-3 py-2.5">
      <Text size="xs" className="text-typography-500 mb-0.5">
        {t('forYou.sectionPrefix')}
      </Text>
      <HStack className="items-start" space="sm">
        {icon && <MaterialIcons name={icon} size={20} color={ACCENT} style={{ marginTop: 2 }} />}
        <Box className="flex-1 min-w-0">{titleNode}</Box>
        {/* Right-aligned round open affordance; the title wraps to its left.
            The COUNT lives on the section's closing row (SectionViewAllText,
            "View all N articles") — this button carries it in its a11y label
            only, so it is never shown twice per section. */}
        {canPress && <SectionOpenButton total={total} onPress={onPress!} />}
      </HStack>
    </VStack>
  );

  // NOT wrapped in an outer Pressable any more: the pill is itself a Pressable,
  // and nesting one inside another makes the inner target's hit area
  // unpredictable. The pill is the affordance.
  return HeaderInner;
};

export default FactSectionHeader;
