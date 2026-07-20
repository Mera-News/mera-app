// TriageActionBar — the five verdict buttons under the triage card.
//
// Read / Good / Bad / Save / Skip. Each button resolves the CURRENT card via the
// triage store (which fires the feedback/persona side effects and advances).
// Bad carries a secondary "tell us why" affordance (long-press, or the inline
// link) that opens the server-owned FeedbackTreeOverlay — the same branching
// dislike flow the card action rows use — and, once the user closes it, resolves
// the card as Bad WITHOUT the automatic topic nudge (the overlay already applied
// the user's chosen persona change, so nudging on top would double-count).

import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import FeedbackTreeOverlay from '@/components/custom/feedback-tree/FeedbackTreeOverlay';
import { getVisitCountForPublication } from '@/lib/database/services/publication-visit-service';
import { hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import logger from '@/lib/logger';
import type { LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import { useTriageStore, type TriageVerdict } from '@/lib/stores/triage-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

const PRIMARY = '#EDA77E';
const NEGATIVE = '#E06A5A';
const ICON_SIZE = 24;

interface TriageActionBarProps {
  /** The card currently under review. Buttons are disabled when null. */
  suggestion: ForYouSuggestion | null;
}

interface VerdictButtonSpec {
  verdict: Exclude<TriageVerdict, never>;
  icon: keyof typeof MaterialIcons.glyphMap;
  labelKey: string;
  color: string;
  haptic: () => void;
}

const TriageActionBar: React.FC<TriageActionBarProps> = ({ suggestion }) => {
  const { t } = useTranslation();
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayCtx, setOverlayCtx] = useState<LocalFeedbackContext>({});

  const resolve = useTriageStore((s) => s.resolve);

  const handleVerdict = useCallback(
    (verdict: TriageVerdict, haptic: () => void) => {
      if (!suggestion) return;
      haptic();
      resolve(suggestion._id, verdict);
    },
    [suggestion, resolve],
  );

  // Bad → "tell us why": open the feedback tree with the live publication-visit
  // count folded in (mirrors ArticleActionsRow.handleDislike). We do NOT resolve
  // yet — the card advances only once the overlay closes.
  const openTellWhy = useCallback(() => {
    if (!suggestion) return;
    hapticMedium();
    void (async () => {
      let publicationVisits = 0;
      const pub = suggestion.publication_name?.trim();
      if (pub) {
        try {
          publicationVisits = await getVisitCountForPublication(
            pub,
            suggestion.country_code ?? null,
          );
        } catch (err) {
          logger.captureException(err, {
            tags: { component: 'TriageActionBar', method: 'visitCount' },
          });
        }
      }
      setOverlayCtx({
        publicationName: suggestion.publication_name,
        countryCode: suggestion.country_code,
        matchedTopics: suggestion.matchedTopics ?? [],
        articleTitle: suggestion.title_en ?? '',
        publicationVisits,
      });
      setOverlayOpen(true);
    })();
  }, [suggestion]);

  const closeTellWhy = useCallback(() => {
    setOverlayOpen(false);
    // Resolve as Bad but skip the automatic nudge — the overlay owns the persona
    // change here, so this only records the dislike + open and advances the deck.
    if (suggestion) resolve(suggestion._id, 'bad', { skipPersonaNudge: true });
  }, [suggestion, resolve]);

  const buttons: VerdictButtonSpec[] = [
    { verdict: 'read', icon: 'menu-book', labelKey: 'triage.read', color: PRIMARY, haptic: hapticMedium },
    { verdict: 'good', icon: 'thumb-up', labelKey: 'triage.good', color: PRIMARY, haptic: hapticSuccess },
    { verdict: 'bad', icon: 'thumb-down', labelKey: 'triage.bad', color: NEGATIVE, haptic: hapticMedium },
    { verdict: 'save', icon: 'bookmark-border', labelKey: 'triage.save', color: PRIMARY, haptic: hapticSuccess },
    { verdict: 'skip', icon: 'skip-next', labelKey: 'triage.skip', color: '#9CA3AF', haptic: hapticLight },
  ];

  const disabled = !suggestion;

  return (
    <>
      <VStack space="xs" className="px-2 pt-3">
        <HStack className="items-stretch justify-between" space="sm">
          {buttons.map((b) => {
            const isBad = b.verdict === 'bad';
            return (
              <Pressable
                key={b.verdict}
                onPress={() => handleVerdict(b.verdict, b.haptic)}
                onLongPress={isBad ? openTellWhy : undefined}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityLabel={t(b.labelKey as never)}
                className="flex-1 items-center justify-center rounded-2xl py-3"
                style={{
                  borderWidth: 1.75,
                  borderColor: b.color,
                  opacity: disabled ? 0.4 : 1,
                }}
              >
                <MaterialIcons name={b.icon} size={ICON_SIZE} color={b.color} />
                <Text
                  size="xs"
                  className="mt-1"
                  style={{ color: b.color, fontWeight: '600' }}
                  numberOfLines={1}
                >
                  {t(b.labelKey as never)}
                </Text>
              </Pressable>
            );
          })}
        </HStack>

        {/* Secondary Bad affordance — also reachable by long-pressing Bad. */}
        <Pressable
          onPress={openTellWhy}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={t('triage.tellWhy')}
          className="items-center py-1"
        >
          <Text size="xs" className="text-typography-500" style={{ opacity: disabled ? 0.4 : 1 }}>
            {t('triage.tellWhy')}
          </Text>
        </Pressable>
      </VStack>

      <FeedbackTreeOverlay
        visible={overlayOpen}
        onClose={closeTellWhy}
        context={overlayCtx}
        chatContext={{
          kind: 'article-suggestion',
          articleId: suggestion?.articleId ?? '',
          suggestionId: suggestion?._id,
          articleTitle: suggestion?.title_en ?? '',
        }}
        chatMessage={t('articleFeedback.thumbsDownMessage', {
          title: suggestion?.title_en ?? '',
        })}
      />
    </>
  );
};

export default TriageActionBar;
