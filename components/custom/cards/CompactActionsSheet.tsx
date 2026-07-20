import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { Pressable } from '@/components/ui/pressable';
import MeraLogo from '@/components/custom/MeraLogo';
import FeedbackTreeOverlay from '@/components/custom/feedback-tree/FeedbackTreeOverlay';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import {
  hasLiked,
  recordArticleFeedback,
  removeArticleFeedback,
} from '@/lib/database/services/article-feedback-service';
import {
  saveSuggestion,
  saveStandaloneArticle,
  deleteSavedSuggestion,
  isSuggestionSaved,
} from '@/lib/database/services/saved-article-suggestion-service';
import { getVisitCountForPublication } from '@/lib/database/services/publication-visit-service';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import { useShareArticle, type ShareArticleParams } from '@/lib/hooks/useShareArticle';
import logger from '@/lib/logger';
import type { LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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

/** Snapshot the subject's contextual extras for the persisted feedback row. */
function buildContextJson(subject: FeedbackSubject): string | null {
  const snapshot: Record<string, unknown> = {};
  if (subject.scopeKey) snapshot.scopeKey = subject.scopeKey;
  if (subject.stableClusterId) snapshot.stableClusterId = subject.stableClusterId;
  if (subject.eventType) snapshot.eventType = subject.eventType;
  if (typeof subject.relevance === 'number') snapshot.relevance = subject.relevance;
  if (subject.matchedTopics && subject.matchedTopics.length > 0) {
    snapshot.matchedTopics = subject.matchedTopics;
  }
  return Object.keys(snapshot).length > 0 ? JSON.stringify(snapshot) : null;
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
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayCtx, setOverlayCtx] = useState<LocalFeedbackContext>({
    articleTitle: subject.title,
  });
  const handleShare = useShareArticle(share);

  const savedId = subject.suggestionId ?? subject.articleId;

  // Restore liked/saved state whenever the sheet opens.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    hasLiked(subject.articleId)
      .then((v) => !cancelled && setLiked(v))
      .catch(() => {});
    isSuggestionSaved(savedId)
      .then((v) => !cancelled && setSaved(v))
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

  const handleLike = useCallback(() => {
    if (liked) {
      hapticLight();
      setLiked(false);
      void removeArticleFeedback(subject.articleId, 'like');
    } else {
      hapticSuccess();
      setLiked(true);
      void recordArticleFeedback({
        articleId: subject.articleId,
        suggestionId: subject.suggestionId,
        sentiment: 'like',
        title: subject.title,
        origin: subject.origin,
        surface: subject.surface,
        contextJson: buildContextJson(subject),
      });
    }
    onClose();
  }, [liked, subject, onClose]);

  const handleDislike = useCallback(() => {
    hapticMedium();
    void recordArticleFeedback({
      articleId: subject.articleId,
      suggestionId: subject.suggestionId,
      sentiment: 'dislike',
      title: subject.title,
      origin: subject.origin,
      surface: subject.surface,
      contextJson: buildContextJson(subject),
    });
    void (async () => {
      let publicationVisits = 0;
      const pub = subject.publicationName?.trim();
      if (pub) {
        try {
          publicationVisits = await getVisitCountForPublication(
            pub,
            subject.countryCode ?? null,
          );
        } catch (err) {
          logger.captureException(err, {
            tags: { component: 'CompactActionsSheet', method: 'visitCount' },
          });
        }
      }
      setOverlayCtx({
        publicationName: subject.publicationName,
        countryCode: subject.countryCode,
        matchedTopics: subject.matchedTopics ?? [],
        articleTitle: subject.title,
        publicationVisits,
      });
      // Hand off from the sheet to the feedback-tree overlay.
      onClose();
      setOverlayOpen(true);
    })();
  }, [subject, onClose]);

  const handleSave = useCallback(() => {
    if (saved) {
      hapticLight();
      setSaved(false);
      void deleteSavedSuggestion(savedId);
    } else {
      hapticSuccess();
      setSaved(true);
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

  const closeOverlay = useCallback(() => setOverlayOpen(false), []);

  const Row = ({
    icon,
    label,
    onPress,
  }: {
    icon: React.ReactNode;
    label: string;
    onPress: () => void;
  }) => (
    <Pressable
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
                    icon={<MeraLogo size={22} />}
                    label="Mera"
                    onPress={handleChat}
                  />
                  <Row
                    icon={<MaterialIcons name={liked ? 'thumb-up' : 'thumb-up-off-alt'} size={22} color={ACCENT} />}
                    label={t('articleFeedback.likeLabel')}
                    onPress={handleLike}
                  />
                  <Row
                    icon={<MaterialIcons name="thumb-down" size={22} color={ACCENT} />}
                    label={t('articleFeedback.dislikeLabel')}
                    onPress={handleDislike}
                  />
                  <Row
                    icon={<MaterialIcons name={saved ? 'bookmark' : 'bookmark-border'} size={22} color={ACCENT} />}
                    label={t('savedSuggestions.savedToastTitle')}
                    onPress={handleSave}
                  />
                  {share?.url ? (
                    <Row
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
        context={overlayCtx}
        chatContext={{
          kind: 'article-suggestion',
          articleId: subject.articleId,
          suggestionId: subject.suggestionId,
          articleTitle: subject.title,
        }}
        chatMessage={t('articleFeedback.thumbsDownMessage', { title: subject.title })}
      />
    </>
  );
};

export default CompactActionsSheet;
