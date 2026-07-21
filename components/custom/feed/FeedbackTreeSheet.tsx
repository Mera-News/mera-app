// FeedbackTreeSheet — the Feed-tab feedback tree rehomed into a bottom sheet
// (RN Modal, CompactActionsSheet pattern). Opened after a thumb tap on a card:
// header (verdict title + close X) + a ScrollView hosting the UNCHANGED
// InlineFeedbackTree and the Ask-Mera entry row, with the "Read on {publication}"
// button pinned as a footer. The X dismisses and leaves the verdict/path stored;
// a terminal leaf auto-settles + closes via onLeafCommitted; an openChat leaf
// escalates to Mera and closes the sheet. Mounted ONCE at screen level.

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import MeraLogo from '@/components/custom/MeraLogo';
import InlineFeedbackTree from './InlineFeedbackTree';
import ReadArticleButton from './ReadArticleButton';
import { useOpenArticleUrl } from './use-open-article-url';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import type { Verdict } from '@/lib/stores/feed-session-store';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, ScrollView } from 'react-native';

const ACCENT = '#EDA77E';

interface FeedbackTreeSheetProps {
  /** null ⇒ the sheet is closed. */
  suggestion: ForYouSuggestion | null;
  verdict: Verdict | null;
  /** Stored node-id path to resume (re-open on the same card). */
  initialPathIds?: string[];
  /** Dismiss (X / backdrop) — leaves the verdict + path stored. */
  onClose: () => void;
  onTreePathChanged: (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => void;
  onInvokeMera: (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => void;
  onLeafCommitted: (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => void;
  /** Mera entry row — invoke Mera with the card's stored verdict + path. */
  onAskMera: () => void;
}

const FeedbackTreeSheet: React.FC<FeedbackTreeSheetProps> = ({
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

  const visible = suggestion != null && verdict != null;

  // An openChat leaf escalates to Mera — close the sheet behind it.
  const handleInvokeMera = (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => {
    onInvokeMera(s, v, pathIds);
    onClose();
  };

  const handleAskMera = () => {
    onAskMera();
    onClose();
  };

  if (!visible) return null;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable
        accessibilityLabel={t('common.cancel')}
        onPress={onClose}
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' }}
      >
        {/* Inner press-swallow so taps inside the panel don't dismiss. */}
        <Pressable onPress={() => {}} style={{ width: '100%' }}>
          <Box
            className="rounded-t-2xl bg-background-50"
            style={{ maxHeight: '70%', borderTopColor: '#2a2a2a', borderTopWidth: 1 }}
          >
            {/* Header: verdict title + close X. */}
            <HStack className="items-center justify-between px-4 pt-4 pb-1">
              <Text className="text-typography-0" style={{ fontSize: 15, fontWeight: '700' }}>
                {verdict === 'like'
                  ? t('swipeFeed.moreLikeThis')
                  : t('swipeFeed.lessLikeThis')}
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

            <ScrollView
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
                  <Text
                    className="flex-1"
                    style={{ color: ACCENT, fontSize: 14, fontWeight: '700' }}
                  >
                    {t('swipeFeed.askMera')}
                  </Text>
                  <MaterialIcons name="arrow-forward-ios" size={12} color={ACCENT} />
                </HStack>
              </Pressable>
            </ScrollView>

            {/* "Read on {publication}" — pinned footer. */}
            <VStack style={{ paddingHorizontal: 14, paddingTop: 6, paddingBottom: 20 }}>
              <ReadArticleButton
                publicationName={suggestion.publication_name}
                onPress={() => openArticleUrl(suggestion)}
                disabled={!suggestion.article_url}
              />
            </VStack>
          </Box>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

export default FeedbackTreeSheet;
