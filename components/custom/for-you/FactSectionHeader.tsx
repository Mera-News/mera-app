import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { eventTypeIcon } from '@/components/custom/for-you/event-type-icons';
import type { FeedSection } from '@/lib/news-harness/feed-select';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

interface FactSectionHeaderProps {
  section: FeedSection;
  /** event_type of the section's top item — drives the icon prefix. */
  eventType: string | null;
  /** The owning fact's real statement — revealed on tap ("why this section"). */
  factStatement: string | null;
}

/**
 * Section header for the fact-sectioned For You feed (Wave 7c N2).
 *
 * Fact sections render a "News about:" prefix + the section title (dynamic, so
 * translated via TranslatableDynamic — NOT a static i18n key), an event-type
 * icon prefix when the top item carries one, and a tap affordance that reveals
 * the owning fact's statement inline (the why-this-section loop). Headline and
 * "also for you" sections render just their title (no prefix / reveal).
 */
const FactSectionHeader: React.FC<FactSectionHeaderProps> = ({
  section,
  eventType,
  factStatement,
}) => {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);

  const isFact = section.kind === 'fact';
  const isAlso = section.kind === 'also';
  const icon = eventTypeIcon(eventType);
  const canReveal = isFact && !!factStatement;

  // "Also for you" is a static UI string; fact/headline titles are dynamic.
  const titleNode = isAlso ? (
    <Text size="lg" bold numberOfLines={1} className="text-white">
      {t('forYou.alsoForYou')}
    </Text>
  ) : (
    <TranslatableDynamic
      text={section.title}
      as="heading"
      size="lg"
      bold
      numberOfLines={1}
      className="text-white"
    />
  );

  const HeaderInner = (
    <VStack className="mb-2 mt-4">
      {isFact && (
        <Text size="xs" className="text-typography-500 mb-0.5">
          {t('forYou.sectionPrefix')}
        </Text>
      )}
      <HStack className="items-center" space="sm">
        {icon && <MaterialIcons name={icon} size={20} color={ACCENT} />}
        <Box className="flex-1 min-w-0">{titleNode}</Box>
        {canReveal && (
          <MaterialIcons
            name={revealed ? 'expand-less' : 'help-outline'}
            size={18}
            color="rgb(163, 163, 163)"
          />
        )}
      </HStack>
      {canReveal && revealed && (
        <Box className="mt-2 rounded-lg bg-gray-900 border border-gray-800 px-3 py-2">
          <Text size="xs" className="text-typography-400">
            {factStatement}
          </Text>
        </Box>
      )}
    </VStack>
  );

  if (!canReveal) {
    return HeaderInner;
  }

  return (
    <Pressable
      onPress={() => setRevealed((v) => !v)}
      accessibilityRole="button"
      accessibilityLabel={t('forYou.whySection')}
    >
      {HeaderInner}
    </Pressable>
  );
};

export default FactSectionHeader;
