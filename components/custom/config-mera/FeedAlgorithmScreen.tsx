import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { setFeedAlgo, useFeedAlgo } from '@/components/custom/feed/feed-view-prefs';
import { Group, Help, Row } from '@/components/custom/you/rows';
import { ScrollView } from '@/components/ui/scroll-view';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import type { FeedAlgoPrefs } from '@/lib/feed-ordering/feed-algo';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { useColors } from '@/lib/theme/tokens';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type KeepDays = `${FeedAlgoPrefs['keepDays']}`;
const KEEP_LABEL_KEYS = {
  '2': 'feedAlgorithm.keep2',
  '3': 'feedAlgorithm.keep3',
  '7': 'feedAlgorithm.keep7',
} as const satisfies Record<KeepDays, string>;

/**
 * Settings > Feed algorithm: the reader's five Feed choices, one settings row
 * (`feed_algo`). The Feed starts a new session at the top on any change.
 */
const FeedAlgorithmScreen: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { t } = useTranslation();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const endClearance = useListEndClearance();
  const algo = useFeedAlgo();

  const toggle = (value: boolean, onToggle: (on: boolean) => void, testID: string) => (
    <Switch testID={testID} value={value} onToggle={onToggle} size="md" />
  );
  const keep = String(algo.keepDays) as KeepDays;

  return (
    <View style={{ flex: 1 }}>
      <AbstractGradientBackdrop />
      <View style={{ flex: 1, paddingTop: insets.top }}>
        <DrillDownHeader title={t('feedAlgorithm.screenTitle')} onBack={onBack} backTestID="feed-algorithm-back" />
        <View style={{ flex: 1 }}>
          <ScrollView
            className="flex-1"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: endClearance }}
          >
            <View style={{ marginTop: 12, marginBottom: 12 }}>
              <Help>{t('feedAlgorithm.intro')}</Help>
            </View>
            <Group>
              <Row
                title={t('feedAlgorithm.skippedTitle')}
                subtitle={t('feedAlgorithm.skippedHint')}
                trailing={toggle(algo.skippedIsRead, (on) => setFeedAlgo({ skippedIsRead: on }), 'feed-algorithm-skipped')}
              />
              <View style={{ padding: 16, gap: 12 }}>
                <View>
                  <Text style={{ color: colors.ink, fontSize: 16 }}>{t('feedAlgorithm.keepTitle')}</Text>
                  <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18, marginTop: 2 }}>
                    {t('feedAlgorithm.keepHint')}
                  </Text>
                </View>
                <SegmentedControl<KeepDays>
                  testID="feed-algorithm-keep"
                  stretch
                  accessibilityLabel={t('feedAlgorithm.keepA11y', { label: t(KEEP_LABEL_KEYS[keep]) })}
                  value={keep}
                  onChange={(v) => setFeedAlgo({ keepDays: Number(v) as FeedAlgoPrefs['keepDays'] })}
                  options={(Object.keys(KEEP_LABEL_KEYS) as KeepDays[]).map((v) => ({
                    value: v,
                    label: t(KEEP_LABEL_KEYS[v]),
                  }))}
                />
              </View>
              <Row
                title={t('feedAlgorithm.mediumTitle')}
                subtitle={t('feedAlgorithm.mediumHint')}
                trailing={toggle(algo.mediumStaysAbove, (on) => setFeedAlgo({ mediumStaysAbove: on }), 'feed-algorithm-medium')}
              />
              <Row
                title={t('feedAlgorithm.seenTitle')}
                subtitle={t('feedAlgorithm.seenHint')}
                trailing={toggle(algo.seenBelowFold, (on) => setFeedAlgo({ seenBelowFold: on }), 'feed-algorithm-seen')}
              />
              {/* The title reads "keep on top", so the switch is the inverse of highSinks. */}
              <Row
                title={t('feedAlgorithm.highTitle')}
                subtitle={t('feedAlgorithm.highHint')}
                trailing={toggle(!algo.highSinks, (on) => setFeedAlgo({ highSinks: !on }), 'feed-algorithm-high')}
              />
            </Group>
          </ScrollView>
        </View>
      </View>
    </View>
  );
};

export default FeedAlgorithmScreen;
