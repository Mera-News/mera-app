import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { Pressable } from '@/components/ui/pressable';
import MeraLogo from '@/components/custom/MeraLogo';
import FeedbackTreeOverlay from '@/components/custom/feedback-tree/FeedbackTreeOverlay';
import { buildContextJson, type FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import {
  getArticleVerdict,
  markFeedbackProcessedFor,
  recordArticleFeedback,
  removeArticleFeedback,
  updateFeedbackContextPath,
  type VerdictSentiment,
} from '@/lib/database/services/article-feedback-service';
import {
  saveSuggestion,
  saveStandaloneArticle,
  deleteSavedSuggestion,
  isSuggestionSaved,
} from '@/lib/database/services/saved-article-suggestion-service';
import { buildOverlayContext } from '@/components/custom/cards/overlay-context';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import { useShareArticle, type ShareArticleParams } from '@/lib/hooks/useShareArticle';
import { useTrackButton } from '@/components/custom/tracked-stories/use-track-button';
import type { LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSavedOverride } from '@/lib/saved-state';
import { Modal, Platform } from 'react-native';

const ACCENT = '#EDA77E';

interface CompactActionsSheetProps {
  visible: boolean;
  onClose: () => void;
  subject: FeedbackSubject;
  suggestion?: ForYouSuggestion;
  article?: NewsArticle;
  share?: ShareArticleParams;
}


/**
 * Compact-row actions sheet — the same universal actions as ArticleActionsRow,
 * laid out as a tappable list in a bottom sheet. Opened by the compact card's
 * "…" trailing button and by long-pressing the row. Kept LIGHTWEIGHT: the parent
 * mounts it only while open, and it returns null when not visible.
 */
export const CompactActionsSheet: React.FC<CompactActionsSheetProps> = ({
  visible,
  onClose,
  subject,
  suggestion,
  article,
  share,
}) => {
  const { t } = useTranslation();
  // D15 — 'none' | 'provisional' (tapped, no reason yet) | 'committed'.
  const [likeState, setLikeState] = useState<'none' | 'provisional' | 'committed'>('none');
  const liked = likeState !== 'none';
  const [savedFromDb, setSavedFromDb] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  // Which tree the overlay is showing — D17 gave the thumbs-UP one too.
  const [overlayRoot, setOverlayRoot] = useState<VerdictSentiment>('dislike');
  const [overlayCtx, setOverlayCtx] = useState<LocalFeedbackContext>({
    articleTitle: subject.title,
  });
  const handleShare = useShareArticle(share);
  // Restore the tracked state only while the sheet is open (matches like/saved).
  const { tracked, onPress: onTrackPress, dialog: trackDialog } = useTrackButton(subject, visible);

  const savedId = subject.suggestionId ?? subject.articleId;
  // See lib/saved-state — a save/delete performed on ANY other surface corrects
  // this row, instead of it holding a stale flag until remount.
  const savedOverride = useSavedOverride(savedId);
  const saved = savedOverride ?? savedFromDb;

  // Restore liked/saved state whenever the sheet opens.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    // Async IIFE — see ArticleActionsRow: the restore is decoration, so a
    // failure anywhere in it (lookup included) must stay non-fatal.
    void (async () => {
      const { verdict, path } = await getArticleVerdict(subject.articleId);
      if (cancelled || verdict !== 'like') return;
      setLikeState(path.length > 0 ? 'committed' : 'provisional');
    })().catch(() => {});
    isSuggestionSaved(savedId)
      .then((v) => !cancelled && setSavedFromDb(v))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible, subject.articleId, savedId]);

  const handleChat = useCallback(() => {
    hapticMedium();
    onClose();
    useFloatingChatStore.getState().expand({
      kind: 'article-suggestion',
      articleId: subject.articleId,
      suggestionId: subject.suggestionId,
      articleTitle: subject.title,
    });
  }, [onClose, subject.articleId, subject.suggestionId, subject.title]);

  // Records the verdict row and hands off from the sheet to the matching tree.
  // Both thumbs do this now (D17): a thumbs-up used to close the sheet and open
  // nothing, so the like tree's boost/weight leaves could never run.
  const recordAndOpenTree = useCallback(
    (sentiment: VerdictSentiment) => {
      void recordArticleFeedback({
        articleId: subject.articleId,
        suggestionId: subject.suggestionId,
        sentiment,
        title: subject.title,
        origin: subject.origin,
        surface: subject.surface,
        contextJson: buildContextJson(subject),
      });
      void (async () => {
        const ctx = await buildOverlayContext(subject);
        setOverlayCtx(ctx);
        setOverlayRoot(sentiment);
        onClose();
        setOverlayOpen(true);
      })();
    },
    [subject, onClose],
  );

  const handleLike = useCallback(() => {
    if (liked) {
      hapticLight();
      setLikeState('none');
      void removeArticleFeedback(subject.articleId, 'like');
      onClose();
      return;
    }
    hapticSuccess();
    setLikeState('provisional');
    recordAndOpenTree('like');
  }, [liked, subject.articleId, recordAndOpenTree, onClose]);

  const handleDislike = useCallback(() => {
    hapticMedium();
    recordAndOpenTree('dislike');
  }, [recordAndOpenTree]);

  // See ArticleActionsRow.handleLeafPicked — the path is what promotes the
  // thumb from provisional to committed; a leaf that applied something also
  // stamps the row so the digest can't double-apply it.
  const handleLeafPicked = useCallback(
    (pathIds: string[], appliedCount: number) => {
      const sentiment = overlayRoot;
      if (sentiment === 'like') setLikeState('committed');
      void (async () => {
        await updateFeedbackContextPath(subject.articleId, sentiment, pathIds);
        if (appliedCount > 0) await markFeedbackProcessedFor(subject.articleId, sentiment);
      })();
    },
    [overlayRoot, subject.articleId],
  );

  const handleSave = useCallback(() => {
    if (saved) {
      hapticLight();
      void deleteSavedSuggestion(savedId);
    } else {
      hapticSuccess();
        if (subject.origin === 'article' && article) {
        void saveStandaloneArticle(article, { surface: subject.surface });
      } else if (suggestion) {
        void saveSuggestion(suggestion);
      }
    }
    onClose();
  }, [saved, savedId, subject.origin, subject.surface, article, suggestion, onClose]);

  const handleSharePress = useCallback(() => {
    hapticLight();
    onClose();
    void handleShare();
  }, [handleShare, onClose]);

  const handleTrack = useCallback(() => {
    // Close the sheet FIRST when starting a follow — the proposal opens in the
    // floating chat behind it. When the story is already tracked the press
    // opens this sheet's own "already following" dialog instead, so the sheet
    // must stay mounted to host it.
    if (tracked) {
      onTrackPress();
      return;
    }
    onTrackPress();
    onClose();
  }, [tracked, onTrackPress, onClose]);

  const closeOverlay = useCallback(() => setOverlayOpen(false), []);

  const Row = ({
    icon,
    label,
    onPress,
    testID,
  }: {
    icon: React.ReactNode;
    label: string;
    onPress: () => void;
    testID?: string;
  }) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="rounded-2xl"
    >
      <HStack className="items-center px-4 py-3" space="md">
        {icon}
        <Text className="flex-1 text-typography-0" style={{ fontSize: 15, fontWeight: '600' }}>
          {label}
        </Text>
      </HStack>
    </Pressable>
  );

  return (
    <>
      {trackDialog}
      {visible ? (
        <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
          <Pressable
            accessibilityLabel={t('common.cancel')}
            onPress={onClose}
            style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' }}
          >
            <Pressable onPress={() => {}} style={{ width: '100%' }}>
              <Box
                className="rounded-t-3xl px-2 pb-8 pt-3"
                style={{ backgroundColor: '#151515', borderTopColor: '#2a2a2a', borderTopWidth: 1 }}
              >
                <VStack space="xs" className="pt-1">
                  <Row
                    testID="card-action-mera"
                    icon={<MeraLogo size={22} />}
                    label="Mera"
                    onPress={handleChat}
                  />
                  <Row
                    testID="card-action-like"
                    // Filled glyph ONLY once the like carries a reason — a bare
                    // tap is provisional and gets the outline glyph (D15).
                    icon={
                      <MaterialIcons
                        name={likeState === 'committed' ? 'thumb-up' : 'thumb-up-off-alt'}
                        size={22}
                        color={ACCENT}
                      />
                    }
                    label={t('articleFeedback.likeLabel')}
                    onPress={handleLike}
                  />
                  <Row
                    testID="card-action-dislike"
                    icon={<MaterialIcons name="thumb-down" size={22} color={ACCENT} />}
                    label={t('articleFeedback.dislikeLabel')}
                    onPress={handleDislike}
                  />
                  <Row
                    testID="card-action-save"
                    icon={<MaterialIcons name={saved ? 'bookmark' : 'bookmark-border'} size={22} color={ACCENT} />}
                    label={t(saved ? 'savedSuggestions.removeAction' : 'savedSuggestions.saveAction')}
                    onPress={handleSave}
                  />
                  <Row
                    testID="card-action-track"
                    icon={<MaterialIcons name="track-changes" size={22} color={tracked ? '#22c55e' : ACCENT} />}
                    label={t(tracked ? 'trackedStories.untrackAction' : 'trackedStories.trackAction')}
                    onPress={handleTrack}
                  />
                  {share?.url ? (
                    <Row
                      testID="card-action-share"
                      icon={<MaterialIcons name={Platform.OS === 'ios' ? 'ios-share' : 'share'} size={22} color={ACCENT} />}
                      label={t('articleDetail.share')}
                      onPress={handleSharePress}
                    />
                  ) : null}
                </VStack>
              </Box>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
      <FeedbackTreeOverlay
        visible={overlayOpen}
        onClose={closeOverlay}
        root={overlayRoot}
        onLeafPicked={handleLeafPicked}
        context={overlayCtx}
        chatContext={{
          kind: 'article-suggestion',
          articleId: subject.articleId,
          suggestionId: subject.suggestionId,
          articleTitle: subject.title,
        }}
        chatMessage={t(
          overlayRoot === 'like'
            ? 'articleFeedback.thumbsUpMessage'
            : 'articleFeedback.thumbsDownMessage',
          { title: subject.title },
        )}
      />
    </>
  );
};

export default CompactActionsSheet;
