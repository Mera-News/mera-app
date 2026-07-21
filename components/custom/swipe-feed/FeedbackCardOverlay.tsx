// FeedbackCardOverlay — the Feed-tab feedback tree rendered INSIDE the top card's
// own frame (the card IS the surface). The screen dims the card (topDimmed) and
// SwipeDeck clips this overlay to the card's exact bounds + rounded corners, so
// visually you're looking at the same card, dimmed, with the feedback UI laid on
// top. A thin dark tint boosts contrast under the CRISP (fully-opaque) title,
// close X, breadcrumb and option rows — there is NO detached panel and NO scrim
// beyond the card. The X dismisses and stays on the same card (verdict/path is
// already stored). A terminal (non-openChat) leaf tap auto-advances via
// onLeafCommitted; an openChat leaf escalates to Mera and closes the overlay.

import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import MeraLogo from '@/components/custom/MeraLogo';
import InlineFeedbackTree from './InlineFeedbackTree';
import ReadArticleButton from './ReadArticleButton';
import { useOpenArticleUrl } from './use-open-article-url';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import type { Verdict } from '@/lib/stores/swipe-deck-store';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';

const ACCENT = '#EDA77E';

interface FeedbackCardOverlayProps {
  suggestion: ForYouSuggestion;
  verdict: Verdict;
  /** Stored node-id path to resume (Back / re-open). */
  initialPathIds?: string[];
  /** Dismiss (X) — stays on the card. */
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
  const openArticleUrl = useOpenArticleUrl();

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
    // Fills the top card's frame (SwipeDeck clips us to its rounded bounds). The
    // tint sits over the already-dimmed card; the content on top is fully opaque.
    <View style={[StyleSheet.absoluteFill, styles.tint]}>
      {/* Header: verdict title + close X — inside the card, fully opaque. */}
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
          <MaterialIcons name="close" size={22} color="#E5E5E5" />
        </Pressable>
      </HStack>

      {/* Scrolls within the card when a level is tall. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 16 }}
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

      {/* "Read on {publication}" — pinned footer so it stays reachable while the
          card is dimmed (mirrors the card's own always-visible read button). */}
      <View style={styles.footer}>
        <ReadArticleButton
          publicationName={suggestion.publication_name}
          onPress={() => openArticleUrl(suggestion)}
          disabled={!suggestion.article_url}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  // A thin dark tint over the (already-dimmed) card content — boosts contrast
  // under the opaque option rows. No panel edges, no scrim beyond the card.
  tint: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    zIndex: 10,
  },
  scroll: {
    flex: 1,
  },
  footer: {
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 14,
  },
});

export default FeedbackCardOverlay;
