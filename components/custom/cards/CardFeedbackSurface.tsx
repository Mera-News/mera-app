import { InlineFeedbackTree } from '@/components/custom/feed/InlineFeedbackTree';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { ScrollView } from '@/components/ui/scroll-view';
import { Text } from '@/components/ui/text';
import type { FeedbackNudge, LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import type { Verdict } from '@/lib/stores/feed-order-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { MAX_FONT_SCALE } from '@/lib/typography/policy';
import { useTextScale } from '@/lib/typography/TextScaleContext';

/** Ceiling for the floating (non-fill) variant at 1x. Scaled at render. */
const SURFACE_MAX_HEIGHT = 340;

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
  onNudge?: (nudge: FeedbackNudge) => void;
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

  // The 340pt ceiling was sized against 13/11px text. The tree below it does
  // scroll, but the heading and caption above it do not — at large text sizes
  // they alone ate most of the box. Growing the ceiling with the text keeps the
  // tree's share of it roughly constant. Hook-derived, so an OS text-size
  // change mid-session re-derives it (a module constant would not).
  const { fontScale } = useWindowDimensions();
  const userScale = useTextScale();
  const cappedHeight =
    SURFACE_MAX_HEIGHT * Math.min(fontScale, MAX_FONT_SCALE.content) * userScale;

  return (
    <Box
      className={fill ? 'w-full h-full px-3 py-3' : 'w-full px-3 py-3 rounded-2xl'}
      style={{ backgroundColor: 'rgba(17,17,17,0.92)', ...(fill ? null : { maxHeight: cappedHeight }) }}
    >
      <HStack className="items-center justify-between">
        {/* On-scale token instead of a pinned 13px — an inline fontSize beats
            the class and would have frozen this outside Dynamic Type. */}
        <Text size="sm" style={{ color: '#FFFFFF', fontWeight: '700' }} numberOfLines={1}>
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
          size="2xs"
          style={{ color: '#9A9A9A', paddingTop: 2 }}
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
