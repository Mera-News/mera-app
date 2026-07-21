import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { ArticleSuggestionCard } from '@/components/custom/cards/ArticleSuggestionCard';
import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import logger from '@/lib/logger';
import { useOpenSuggestion } from '@/lib/hooks/use-open-suggestion';
import {
  buildFactRows,
  isSuggestionOpened,
  type FactRowGroup,
} from '@/lib/stores/fact-rows-selector';
import { loadSectionSnapshots, type SectionSnapshots } from '@/lib/stores/section-snapshots';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useForYouSuggestions } from '@/lib/stores/selectors';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface FactFeedScreenProps {
  factId: string;
  /** Fact display title, passed through from the row header (avoids a reload
   *  flash before the snapshots hydrate). */
  statement: string;
}

/** Distinct extra source publications a collapsed story carries ("+N sources"). */
function moreSourcesCount(rep: ForYouSuggestion, members: ForYouSuggestion[]): number {
  if (members.length === 0) return 0;
  const repPub = (rep.publication_name ?? '').trim().toLowerCase();
  const distinct = new Set<string>();
  for (const m of members) {
    const pub = (m.publication_name ?? '').trim().toLowerCase();
    if (pub !== repPub) distinct.add(pub || `__unknown_${m._id}`);
  }
  return distinct.size > 0 ? distinct.size : members.length;
}

/**
 * The full feed for a single fact (Round-3 C2). Reached by tapping a fact row's
 * header. Plain vertical list of full article cards, pubDate desc; each collapsed
 * story shows the newest member (so the card's timestamp is the newest member's
 * pubDate) with a "+N sources" chip.
 */
const FactFeedScreen: React.FC<FactFeedScreenProps> = ({ factId, statement }) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const suggestions = useForYouSuggestions();
  const openedIds = useOpenedStoriesStore((s) => s.ids);
  const handlePress = useOpenSuggestion('sectioned');
  const [snapshots, setSnapshots] = useState<SectionSnapshots | null>(null);

  useEffect(() => {
    void useOpenedStoriesStore.getState().hydrate();
    let cancelled = false;
    loadSectionSnapshots()
      .then((s) => { if (!cancelled) setSnapshots(s); })
      .catch((err: unknown) => {
        logger.captureException(err, {
          tags: { screen: 'FactFeedScreen', method: 'loadSectionSnapshots' },
        });
      });
    return () => { cancelled = true; };
  }, []);

  const groups: FactRowGroup[] = useMemo(() => {
    if (!snapshots) return [];
    const { rows } = buildFactRows(suggestions, snapshots, openedIds);
    return rows.find((r) => r.factId === factId)?.groups ?? [];
  }, [snapshots, suggestions, factId, openedIds]);

  const renderItem = useCallback(
    ({ item }: { item: FactRowGroup }) => (
      <ArticleSuggestionCard
        suggestion={item.data}
        moreSourcesCount={moreSourcesCount(item.data, item.members)}
        onPress={handlePress}
        surface="for_you"
        read={isSuggestionOpened(item.data, openedIds)}
        flat
      />
    ),
    [handlePress, openedIds],
  );

  return (
    <Box className="flex-1 bg-black">
      <HStack
        className="items-center px-4 pb-3 border-b border-gray-900"
        style={{ paddingTop: insets.top + 12 }}
        space="sm"
      >
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.back')}
        >
          <MaterialIcons name="arrow-back" size={24} color="#FFFFFF" />
        </Pressable>
        <Box className="flex-1 min-w-0">
          <Text size="xs" className="text-typography-500">{t('forYou.sectionPrefix')}</Text>
          <TranslatableDynamic
            text={statement}
            as="heading"
            size="lg"
            bold
            numberOfLines={1}
            className="text-white"
          />
        </Box>
      </HStack>
      <FlatList
        data={groups}
        keyExtractor={(g) => g.data._id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingHorizontal: 0, paddingVertical: 16, paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={<AllCaughtUpCard />}
      />
    </Box>
  );
};

export default FactFeedScreen;
