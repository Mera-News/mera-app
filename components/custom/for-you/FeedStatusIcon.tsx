// The Feed tab's status at a glance (FinalFeedStatus): the Mera mark in the
// header's leading slot. Still and white at rest, moving while a sync runs,
// orange at the daily limit, red on a problem. A tap opens the Feed's one
// counts card (feed-status-card.ts); the label says the state and what the
// tap does.
//
// The mark holds still by itself in Lite mode, under Reduce Motion and off
// screen. "Moving" follows `statusMode === 'processing'`, which also goes true
// on each 5-minute poll: accepted for the icon. FeedScreen announces the
// capped and error states (useFeedModeAnnouncement).

import MeraLogo from '@/components/custom/MeraLogo';
import { type FeedStatusMode } from '@/lib/feed-status-mode';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { useColors } from '@/lib/theme/tokens';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { a11yStateKey, statusIconInk } from './status-ink';

export interface FeedStatusIconProps {
  readonly onPress: () => void;
  /** Injected by the kit gallery; the live mode otherwise. */
  readonly mode?: FeedStatusMode;
}

const FeedStatusIcon: React.FC<FeedStatusIconProps> = ({ onPress, mode: modeOverride }) => {
  const { t } = useTranslation();
  const tAny = t as unknown as (key: string) => string;
  const liveMode = useFeedStatusMode();
  const mode = modeOverride ?? liveMode;
  const colors = useColors();
  return (
    <View style={styles.frame} testID="feed-status-icon-frame">
      <View
        pointerEvents="none"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <MeraLogo size={26} color={statusIconInk(mode, colors)} animated={mode === 'processing'} />
      </View>
      {/* Childless labelled button over the visual (the glyph-leak pattern). */}
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${tAny(a11yStateKey(mode))}. ${t('feedStatus.openA11y')}`}
        testID="feed-status-icon"
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  frame: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});

export default FeedStatusIcon;
