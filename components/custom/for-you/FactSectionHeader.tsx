import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { eventTypeIcon } from '@/components/custom/for-you/event-type-icons';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

interface FactSectionHeaderProps {
  /** `fact` rows show the "News about:" prefix + the fact title; `also` renders
   *  the static "Also for you" string. */
  kind: 'fact' | 'also';
  /** The fact's display title (fact rows only — ignored for `also`). */
  title: string;
  /** event_type of the row's top item — drives the icon prefix. */
  eventType: string | null;
  /** Stories that became visible in this section since the user's last visit —
   *  renders a small accent "+N" pill after the title. Hidden when 0 /
   *  undefined. */
  newCount?: number;
  /** When set, the whole header is tappable and opens the full fact feed. */
  onPress?: () => void;
}

/**
 * Row header for the fact-rows For You feed (Round-3 C2).
 *
 * Fact rows render a "News about:" prefix + the fact title (dynamic, so
 * translated via TranslatableDynamic), an optional event-type icon, and — when
 * `onPress` is supplied — a chevron affordance whose tap opens the fact's full
 * feed (`FactFeedScreen`). The "Also for you" catch-all header renders just its
 * static title (no prefix / navigation).
 */
const FactSectionHeader: React.FC<FactSectionHeaderProps> = ({
  kind,
  title,
  eventType,
  newCount = 0,
  onPress,
}) => {
  const { t } = useTranslation();

  const isFact = kind === 'fact';
  const icon = eventTypeIcon(eventType);
  // fact + "also" rows navigate into the section's full feed when `onPress` is
  // supplied.
  const canPress = !!onPress;

  const titleNode = isFact ? (
    <TranslatableDynamic
      text={title}
      as="heading"
      size="lg"
      bold
      numberOfLines={1}
      className="text-white"
    />
  ) : (
    <Text size="lg" bold numberOfLines={1} className="text-white">
      {t('forYou.alsoForYou')}
    </Text>
  );

  const HeaderInner = (
    // Internal padding (no outer margins) so the header text sits on the
    // gradient ink of the enclosing SectionGradientPanel.
    <VStack className="px-3 py-2.5">
      {isFact && (
        <Text size="xs" className="text-typography-500 mb-0.5">
          {t('forYou.sectionPrefix')}
        </Text>
      )}
      <HStack className="items-center" space="sm">
        {icon && <MaterialIcons name={icon} size={20} color={ACCENT} />}
        <Box className="flex-1 min-w-0">{titleNode}</Box>
        {newCount > 0 && (
          <Box
            className="rounded-full items-center justify-center px-1.5"
            style={{ minWidth: 20, height: 20, backgroundColor: ACCENT }}
            accessibilityLabel={t('forYou.newInSection', { count: newCount })}
          >
            <Text size="xs" bold className="text-black">
              {newCount > 99 ? '+99' : `+${newCount}`}
            </Text>
          </Box>
        )}
        {canPress && (
          <MaterialIcons name="chevron-right" size={22} color="rgb(163, 163, 163)" />
        )}
      </HStack>
    </VStack>
  );

  if (!canPress) {
    return HeaderInner;
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('forYou.openFactFeed')}
    >
      {HeaderInner}
    </Pressable>
  );
};

export default FactSectionHeader;
