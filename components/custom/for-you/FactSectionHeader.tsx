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
  /** Small line above the title. Defaults to the "News about:" fact prefix;
   *  pass `null` for a section that is not about a fact (headline sections,
   *  whose title already says what the section is). */
  prefix?: string | null;
  /** False for titles that are already app copy in the reader's language
   *  (headline sections) — running them through TranslatableDynamic would
   *  machine-translate an already-localized string. Defaults true (fact
   *  statements ARE user data and must be translated). */
  translateTitle?: boolean;
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
  prefix,
  translateTitle = true,
}) => {
  const { t } = useTranslation();

  const icon = eventTypeIcon(eventType);
  const canPress = !!onPress;
  // `undefined` ⇒ the default fact prefix; `null` ⇒ no prefix row at all.
  const prefixText = prefix === undefined ? t('forYou.sectionPrefix') : prefix;

  const titleNode = translateTitle ? (
    <TranslatableDynamic
      text={title}
      as="heading"
      size="xl"
      bold
      // Wraps to a second line instead of truncating — a truncated fact
      // ("Works as a software engineer buildin…") was unreadable and the full
      // text appeared nowhere else.
      numberOfLines={2}
      className="text-white"
    />
  ) : (
    <Text size="lg" bold numberOfLines={2} className="text-white">
      {title}
    </Text>
  );

  const HeaderInner = (
    // Internal padding (no outer margins) so the header text sits on the
    // gradient ink of the enclosing SectionGradientPanel.
    <VStack className="px-3 py-2.5">
      {!!prefixText && (
        <Text size="xs" className="text-typography-500 mb-0.5">
          {prefixText}
        </Text>
      )}
      <HStack className="items-start" space="sm">
        {icon && <MaterialIcons name={icon} size={20} color={ACCENT} style={{ marginTop: 2 }} />}
        <Box className="flex-1 min-w-0">{titleNode}</Box>
        {/* Right-aligned round open affordance; the title wraps to its left.
            The COUNT lives on the section's closing row (SectionViewAllText,
            "View all N articles") — this button carries it in its a11y label
            only, so it is never shown twice per section. */}
        {/* alignSelf center, NOT items-center on the row: the row stays
            `items-start` so the event-type icon keeps hugging the title's FIRST
            line, while this button centres against the whole title block — which
            is what a two-line wrapped fact title needs. */}
        {canPress && (
          <Box style={{ alignSelf: 'center' }}>
            <SectionOpenButton total={total} onPress={onPress!} />
          </Box>
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
