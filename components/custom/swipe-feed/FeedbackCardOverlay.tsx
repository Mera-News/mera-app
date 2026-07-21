// FeedbackCardOverlay — the Feed-tab feedback tree floated OVER the top card
// (not the whole screen). When the user taps a thumb on the VerdictBar the screen
// dims the card and mounts this overlay: a dark scrim filling the deck area with a
// centered, scrollable panel carrying the InlineFeedbackTree (breadcrumb + chip
// levels) plus a Mera entry. Tapping the scrim (outside the panel) or the X
// dismisses it and keeps the user on the same card (the verdict/path is already
// stored). A terminal (non-openChat) leaf tap auto-advances via onLeafCommitted.

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import MeraLogo from '@/components/custom/MeraLogo';
import InlineFeedbackTree from './InlineFeedbackTree';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import type { Verdict } from '@/lib/stores/swipe-deck-store';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet } from 'react-native';

const ACCENT = '#EDA77E';

interface FeedbackCardOverlayProps {
  suggestion: ForYouSuggestion;
  verdict: Verdict;
  /** Stored node-id path to resume (Back / re-open). */
  initialPathIds?: string[];
  /** Dismiss (X or scrim tap) — stays on the card. */
  onClose: () => void;
  onTreePathChanged: (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => void;
  onInvokeMera: (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => void;
  onLeafCommitted: (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => void;
  /** Mera entry row — invoke Mera with the card's stored verdict + path. */
  onAskMera: () => void;
}

const FeedbackCardOverlay: React.FC<FeedbackCardOverlayProps> = ({
  suggestion,
  verdict,
  initialPathIds,
  onClose,
  onTreePathChanged,
  onInvokeMera,
  onLeafCommitted,
  onAskMera,
}) => {
  const { t } = useTranslation();

  // An openChat leaf escalates to Mera — close the overlay behind it.
  const handleInvokeMera = (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => {
    onInvokeMera(s, v, pathIds);
    onClose();
  };

  const handleAskMera = () => {
    onAskMera();
    onClose();
  };

  return (
    // Scrim over the deck area — tap outside the panel to dismiss.
    <Pressable
      accessibilityLabel={t('swipeFeed.closeTree')}
      onPress={onClose}
      style={[StyleSheet.absoluteFill, styles.scrim]}
    >
      {/* Panel — stop propagation so inner taps don't dismiss. */}
      <Pressable onPress={() => {}} style={styles.panelWrap}>
        <Box className="rounded-2xl border border-outline-200" style={styles.panel}>
          {/* Header: title + close. */}
          <HStack className="items-center justify-between px-4 pt-3 pb-1">
            <Text className="text-typography-0" style={{ fontSize: 15, fontWeight: '700' }}>
              {verdict === 'like' ? t('swipeFeed.moreLikeThis') : t('swipeFeed.lessLikeThis')}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('swipeFeed.closeTree')}
              onPress={onClose}
              hitSlop={10}
              className="rounded-full p-1"
            >
              <MaterialIcons name="close" size={22} color="#8a8a8a" />
            </Pressable>
          </HStack>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 12 }}
            keyboardShouldPersistTaps="handled"
          >
            <InlineFeedbackTree
              suggestion={suggestion}
              verdict={verdict}
              onTreePathChanged={onTreePathChanged}
              onInvokeMera={handleInvokeMera}
              onLeafCommitted={onLeafCommitted}
              initialPathIds={initialPathIds}
            />

            {/* Mera entry. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('swipeFeed.askMera')}
              onPress={handleAskMera}
              className="mt-3 rounded-2xl"
              style={{ borderColor: ACCENT, borderWidth: 1 }}
            >
              <HStack className="items-center px-3.5 py-2.5" space="sm">
                <MeraLogo size={22} />
                <Text className="flex-1" style={{ color: ACCENT, fontSize: 14, fontWeight: '700' }}>
                  {t('swipeFeed.askMera')}
                </Text>
                <MaterialIcons name="arrow-forward-ios" size={12} color={ACCENT} />
              </HStack>
            </Pressable>
          </ScrollView>
        </Box>
      </Pressable>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  scrim: {
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    zIndex: 10,
  },
  panelWrap: {
    width: '100%',
    maxWidth: 420,
  },
  panel: {
    backgroundColor: '#151515',
    maxHeight: '86%',
    overflow: 'hidden',
  },
  scroll: {
    flexGrow: 0,
  },
});

export default FeedbackCardOverlay;
