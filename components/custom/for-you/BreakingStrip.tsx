import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { BreakingCardData } from '@/lib/stores/fact-rows-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';

const RED = '#EF4444'; // error/red accent

interface BreakingStripProps {
  items: BreakingCardData[];
  onPressItem: (suggestion: ForYouSuggestion) => void;
}

/**
 * Compact horizontal "Emergency" strip pinned above all sections when the feed
 * has EMERGENCY-band items. Dark card row, `warning` icon + red-accent chip,
 * horizontally scrollable when there is more than one item. Static by design —
 * no pulse animation, so it is reduce-motion safe with no extra gating.
 *
 * Membership is `isEmergency` (EMERGENCY band only), NOT `isBreaking` — the
 * latter also admits HIGH-band disaster/weather/conflict stories, which is how
 * ordinary high-relevance items ended up under a red alert chip. See the long
 * note on `isEmergency` in `fact-rows-selector`.
 *
 * The label reuses `relevance.emergency`, the SAME string the relevance band is
 * named by everywhere else (the Low+/Med+/High dial, section headers). One
 * concept, one string, already translated in all 20 locales — a strip that said
 * something different from the band it represents is how the old "Breaking"
 * wording drifted from what it actually gated on.
 *
 * The file/prop/type names still say "breaking" throughout. That is deliberate:
 * renaming them reaches `DashboardSectionsFeed`, `ForYouScreen`,
 * `BreakingCardData` and their fixtures for zero behaviour change.
 */
const BreakingStrip: React.FC<BreakingStripProps> = ({ items, onPressItem }) => {
  const { t } = useTranslation();
  if (items.length === 0) return null;

  const cards = items.map(({ data }) => {
    const title = data.title_en ?? data.title_original ?? '';
    return (
      <Pressable
        key={data._id}
        onPress={() => onPressItem(data)}
        accessibilityRole="button"
        accessibilityLabel={`${t('relevance.emergency')}: ${title}`}
        className="rounded-xl border border-error-700 bg-gray-950 px-3 py-2 mr-2"
        style={{ maxWidth: 320, minWidth: 260 }}
      >
        <HStack className="items-center mb-1" space="xs">
          <MaterialIcons name="warning" size={14} color={RED} />
          <Box className="rounded-full px-2 py-0.5" style={{ backgroundColor: RED }}>
            <Text size="2xs" bold style={{ color: '#FFFFFF' }}>
              {t('relevance.emergency').toUpperCase()}
            </Text>
          </Box>
        </HStack>
        <TranslatableDynamic
          text={title}
          originalText={data.title_original ?? undefined}
          originalLanguage={data.language_code ?? undefined}
          size="sm"
          numberOfLines={2}
          className="text-white"
        />
      </Pressable>
    );
  });

  return (
    <Box className="mb-2">
      {items.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingRight: 8 }}
        >
          {cards}
        </ScrollView>
      ) : (
        cards
      )}
    </Box>
  );
};

export default BreakingStrip;
