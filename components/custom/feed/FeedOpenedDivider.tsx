// FeedOpenedDivider — the SECOND of the Feed's two dividers: the boundary
// between stories the user merely saw (dwelt past / thumbed / saved) and stories
// they actually opened and read.
//
// Deliberately a SLIM label row, not a card. The first divider is the full
// AllCaughtUpCard — a celebratory rest stop the user is meant to dwell on — so
// this one has to read as a quiet section label instead, or the two boundaries
// become indistinguishable at a glance, which is the entire reason there are
// two. Everything below it is re-readable history, not news.
//
// No props: it renders the same everywhere and is memoised, so it never
// re-renders as the list around it changes.

import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

const FeedOpenedDivider: React.FC = () => {
  const { t } = useTranslation();
  return (
    <Box className="px-1 pt-6 pb-3" testID="feed-divider-opened">
      {/* Hairline rule — the visual "everything below here is history" cut. */}
      <View
        style={{
          height: StyleSheet.hairlineWidth,
          backgroundColor: 'rgba(255,255,255,0.12)',
        }}
      />
      <VStack className="pt-3" space="xs">
        <Text size="sm" className="text-typography-500 font-semibold">
          {t('feed.divider.openedTitle')}
        </Text>
        <Text size="xs" className="text-typography-400">
          {t('feed.divider.openedSubtitle')}
        </Text>
      </VStack>
    </Box>
  );
};

export default React.memo(FeedOpenedDivider);
