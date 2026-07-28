import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import SectionStoriesPill from '@/components/custom/for-you/SectionStoriesPill';
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
  /** TOTAL stories in this section — rendered as the "N stories" pill on the
   *  right, which also opens the full fact feed. */
  total: number;
  /** When set, the whole header is tappable and opens the full fact feed. */
  onPress?: () => void;
}

/**
 * Row header for the fact-rows For You feed (Round-3 C2).
 *
 * Renders a "News about:" prefix + the fact title (dynamic, so translated via
 * TranslatableDynamic), an optional event-type icon, and the "N stories" pill
 * (right-aligned; the title WRAPS to its left rather than truncating to one
 * line). Tapping either the pill or the header opens the fact's full feed
 * (`FactFeedScreen`).
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
        {/* Right-aligned pill; the title above wraps to its left. Identical to
            the one closing the section — same component, same props. */}
        {canPress && (
          <SectionStoriesPill
            total={total}
            onPress={onPress!}
            testID="dashboard-section-stories-pill"
          />
        )}
      </HStack>
    </VStack>
  );

  // NOT wrapped in an outer Pressable any more: the pill is itself a Pressable,
  // and nesting one inside another makes the inner target's hit area
  // unpredictable. The pill is the affordance.
  return HeaderInner;
};

export default FactSectionHeader;
