import { InlineFeedbackTree } from '@/components/custom/feed/InlineFeedbackTree';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import type { LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import type { Verdict } from '@/lib/stores/feed-order-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

export interface CardFeedbackSurfaceProps {
  suggestion: ForYouSuggestion;
  verdict: Verdict;
  /** Context the tree cannot derive from a local `article_suggestions` row
   *  because there isn't one — a standalone article on the detail screen. */
  contextFallback?: Partial<LocalFeedbackContext>;
  initialPathIds?: string[];
  /** True once a TERMINAL leaf settled (or the user escalated to Mera). Drives
   *  whether the "a bare thumb is discarded" caption is still true. */
  committed?: boolean;
  /** The × was tapped — hide the surface (keeps the verdict). */
  onClose: () => void;
  onTreePathChanged: (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => void;
  onInvokeMera: (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => void;
  onLeafCommitted: (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => void;
  /** A `nudge` leaf was tapped — pure pass-through to the tree. The host decides
   *  what "browse related" means on its surface (the feed opens the detail
   *  screen; the detail screen scrolls to its related-articles footer). */
  onNudge?: (nudge: 'subscribe' | 'browse_related') => void;
  /** Fill the parent (the feed card's absolute overlay slot). When false the
   *  surface sizes to its content with a capped height + rounded corners — the
   *  detail screen's floating panel. Default true. */
  fill?: boolean;
}

/**
 * The inline feedback surface — a translucent dark-grey panel that FLOATS over a
 * card's content region (rendered via `ArticleCardBase`'s `overlay` slot, so it
 * covers the hero/meta/title/reason but not the action row). It hosts the
 * reason-picker `InlineFeedbackTree` with a header + close (×). Non-blocking: the
 * verdict is already captured, so the user can pick a reason or just close/scroll.
 */
export const CardFeedbackSurface: React.FC<CardFeedbackSurfaceProps> = ({
  suggestion,
  verdict,
  contextFallback,
  initialPathIds,
  committed = false,
  onClose,
  onTreePathChanged,
  onInvokeMera,
  onLeafCommitted,
  onNudge,
  fill = true,
}) => {
  const { t } = useTranslation();
  const heading = verdict === 'like' ? t('swipeFeed.moreLikeThis') : t('swipeFeed.lessLikeThis');
  // D15 — say plainly what a bare thumb is worth, and stop saying it the
  // moment the user has answered. The app used to quietly speculate from
  // context-less taps; it now discards them, and the user is told so.
  //
  // F2 — "has answered" means COMMITTED, not "has navigated". Descending a
  // branch used to retract the caption while the promise it made was still in
  // force, so the panel stopped explaining itself exactly where it mattered
  // most: mid-navigation, with the tap still discardable.
  const uncommitted = !committed;

  return (
    <Box
      className={fill ? 'w-full h-full px-3 py-3' : 'w-full px-3 py-3 rounded-2xl'}
      style={{ backgroundColor: 'rgba(17,17,17,0.92)', ...(fill ? null : { maxHeight: 340 }) }}
    >
      <HStack className="items-center justify-between">
        <Text style={{ color: '#FFFFFF', fontSize: 13, fontWeight: '700' }} numberOfLines={1}>
          {heading}
        </Text>
        <Pressable
          onPress={onClose}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t('swipeFeed.closeTree')}
          className="p-1"
        >
          <MaterialIcons name="close" size={18} color="#B4B4B4" />
        </Pressable>
      </HStack>
      {uncommitted ? (
        <Text
          testID="feedback-caption"
          style={{ color: '#9A9A9A', fontSize: 11, lineHeight: 15, paddingTop: 2 }}
        >
          {t('swipeFeed.feedbackCaption')}
        </Text>
      ) : null}
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 4 }}
      >
        <InlineFeedbackTree
          suggestion={suggestion}
          verdict={verdict}
          contextFallback={contextFallback}
          initialPathIds={initialPathIds}
          rootLabel={heading}
          onTreePathChanged={onTreePathChanged}
          onInvokeMera={onInvokeMera}
          onLeafCommitted={onLeafCommitted}
          onNudge={onNudge}
        />
      </ScrollView>
    </Box>
  );
};

export default CardFeedbackSurface;
