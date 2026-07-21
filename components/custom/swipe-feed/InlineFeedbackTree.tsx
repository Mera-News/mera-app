// InlineFeedbackTree — the Feed-tab feedback tree, rendered INLINE beneath the
// VerdictBar (via its `treeSlot`) once a verdict exists. Unlike the dislike
// overlay it applies NO persona mutations: every tap simply enriches the stored
// verdict row's path (onTreePathChanged), and an `openChat` leaf escalates to
// the Mera chat (onInvokeMera). The tree content + gating come from the shared
// engine (like OR dislike root depending on the verdict).

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useFeedbackTreeEngine } from '@/components/custom/feedback-tree/useFeedbackTreeEngine';
import { getVisitCountForPublication } from '@/lib/database/services/publication-visit-service';
import { getSuggestionFeedbackContext } from '@/lib/database/services/article-suggestion-service';
import { hapticLight, hapticMedium } from '@/lib/haptics';
import logger from '@/lib/logger';
import type {
  FeedbackTreeNode,
  LocalFeedbackContext,
} from '@/lib/news-harness/feedback-tree';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import type { Verdict } from '@/lib/stores/swipe-deck-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = '#EDA77E';
const CHIP_BG = '#1e1e1e';
const CHIP_BORDER = '#333333';
const SELECTED_BG = 'rgba(237,167,126,0.18)';

export interface InlineFeedbackTreeProps {
  suggestion: ForYouSuggestion;
  verdict: Verdict;
  /** Persist the tapped node-id path onto the stored verdict row. */
  onTreePathChanged: (suggestion: ForYouSuggestion, verdict: Verdict, pathIds: string[]) => void;
  /** Escalate to the Mera chat (openChat leaves + the VerdictBar's Mera icon). */
  onInvokeMera: (suggestion: ForYouSuggestion, verdict: Verdict, pathIds: string[]) => void;
  /** A TERMINAL leaf (childless, NON-openChat: actions/nudge/seenOnly) was tapped
   *  after its path was recorded — the overlay uses this to settle + auto-advance. */
  onLeafCommitted?: (suggestion: ForYouSuggestion, verdict: Verdict, pathIds: string[]) => void;
  /** Stored node-id path to resume when revisiting a card (Back). */
  initialPathIds?: string[];
}

/** Builds the on-device gating/resolution context for a suggestion (async). */
async function buildLocalContext(suggestion: ForYouSuggestion): Promise<LocalFeedbackContext> {
  const matchedTopics = suggestion.matchedTopics ?? [];
  let category: string | null = null;
  try {
    const fb = await getSuggestionFeedbackContext({
      suggestionId: suggestion._id,
      articleId: suggestion.articleId,
    });
    if (fb) category = fb.category;
  } catch (err) {
    logger.captureException(err, {
      tags: { component: 'InlineFeedbackTree', method: 'feedbackContext' },
    });
  }

  let publicationVisits = 0;
  const pub = suggestion.publication_name?.trim();
  if (pub) {
    try {
      publicationVisits = await getVisitCountForPublication(pub, suggestion.country_code ?? null);
    } catch (err) {
      logger.captureException(err, {
        tags: { component: 'InlineFeedbackTree', method: 'visitCount' },
      });
    }
  }

  return {
    publicationName: suggestion.publication_name,
    countryCode: suggestion.country_code,
    articleTitle: suggestion.title_en,
    category,
    eventType: suggestion.eventType ?? undefined,
    matchedTopics,
    publicationVisits,
  };
}

export const InlineFeedbackTree: React.FC<InlineFeedbackTreeProps> = ({
  suggestion,
  verdict,
  onTreePathChanged,
  onInvokeMera,
  onLeafCommitted,
  initialPathIds,
}) => {
  const { t } = useTranslation();

  // On-device context — starts minimal (context-free gating) and enriches once
  // the async lookups resolve, so the tree renders immediately with no blank.
  const [context, setContext] = useState<LocalFeedbackContext>({
    articleTitle: suggestion.title_en,
    matchedTopics: suggestion.matchedTopics ?? [],
  });
  useEffect(() => {
    let cancelled = false;
    void buildLocalContext(suggestion).then((ctx) => {
      if (!cancelled) setContext(ctx);
    });
    return () => {
      cancelled = true;
    };
  }, [suggestion]);

  const engine = useFeedbackTreeEngine({
    active: true,
    root: verdict === 'like' ? 'like' : 'dislike',
    context,
  });
  const { tree, path, currentChildren, pathIds, descend, goToDepth, restorePath, findNode } = engine;

  // Selected-leaf styling (an actions/nudge/seenOnly leaf the user tapped).
  const [selectedLeafId, setSelectedLeafId] = useState<string | null>(null);

  // Resume a revisited card's stored path once the tree is loaded.
  useEffect(() => {
    if (!tree || !initialPathIds || initialPathIds.length === 0) return;
    restorePath(initialPathIds);
    const lastId = initialPathIds[initialPathIds.length - 1];
    const node = findNode(lastId);
    if (node && !(node.children && node.children.length > 0)) setSelectedLeafId(lastId);
    // Restore once per tree load; navigation thereafter is user-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]);

  const label = useCallback(
    (node: FeedbackTreeNode) => t(node.labelKey, { defaultValue: node.labelDefault }) as string,
    [t],
  );

  const handleSelect = useCallback(
    (node: FeedbackTreeNode) => {
      const nextIds = [...pathIds, node.id];
      const isBranch = !!node.children && node.children.length > 0;

      if (isBranch) {
        hapticMedium();
        setSelectedLeafId(null);
        descend(node);
        onTreePathChanged(suggestion, verdict, nextIds);
        return;
      }

      // Leaf. openChat escalates to Mera; all others just record the path (no
      // persona mutation — nudge/seenOnly/actions leaves are informational here).
      if (node.leaf?.openChat) {
        hapticMedium();
        onTreePathChanged(suggestion, verdict, nextIds);
        onInvokeMera(suggestion, verdict, nextIds);
        return;
      }

      hapticLight();
      setSelectedLeafId(node.id);
      onTreePathChanged(suggestion, verdict, nextIds);
      // Terminal (non-openChat) leaf — let the overlay settle + auto-advance.
      onLeafCommitted?.(suggestion, verdict, nextIds);
    },
    [pathIds, descend, onTreePathChanged, onInvokeMera, onLeafCommitted, suggestion, verdict],
  );

  const handleCrumb = useCallback(
    (depth: number) => {
      hapticLight();
      setSelectedLeafId(null);
      goToDepth(depth);
    },
    [goToDepth],
  );

  const breadcrumb = useMemo(() => path.map((n) => label(n)), [path, label]);

  if (!tree) return null;

  const renderChip = (node: FeedbackTreeNode) => {
    const isBranch = !!node.children && node.children.length > 0;
    const selected = selectedLeafId === node.id;
    return (
      <Pressable
        key={node.id}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={label(node)}
        onPress={() => handleSelect(node)}
        className="rounded-2xl"
        style={{
          backgroundColor: selected ? SELECTED_BG : CHIP_BG,
          borderColor: selected ? ACCENT : CHIP_BORDER,
          borderWidth: 1,
        }}
      >
        <HStack className="items-center px-3.5 py-2.5" space="sm">
          {node.icon ? (
            <MaterialIcons
              name={node.icon as keyof typeof MaterialIcons.glyphMap}
              size={18}
              color={ACCENT}
            />
          ) : null}
          <Text className="flex-1 text-typography-0" style={{ fontSize: 14, fontWeight: '600' }}>
            {label(node)}
          </Text>
          {isBranch ? (
            <MaterialIcons name="arrow-forward-ios" size={12} color="#8a8a8a" />
          ) : selected ? (
            <MaterialIcons name="check" size={16} color={ACCENT} />
          ) : null}
        </HStack>
      </Pressable>
    );
  };

  return (
    <VStack space="xs" className="pt-1">
      {/* Breadcrumb — tap a crumb to jump back to that level. */}
      {breadcrumb.length > 0 ? (
        <HStack className="flex-wrap items-center" space="xs">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('swipeFeed.treeRoot')}
            onPress={() => handleCrumb(0)}
          >
            <Text style={{ color: ACCENT, fontSize: 12, fontWeight: '700' }}>
              {t('swipeFeed.treeRoot')}
            </Text>
          </Pressable>
          {breadcrumb.map((crumb, i) => (
            <HStack key={`${crumb}-${i}`} className="items-center" space="xs">
              <MaterialIcons name="chevron-right" size={14} color="#6a6a6a" />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={crumb}
                onPress={() => handleCrumb(i + 1)}
              >
                <Text
                  className="text-typography-300"
                  style={{ fontSize: 12, fontWeight: '600' }}
                  numberOfLines={1}
                >
                  {crumb}
                </Text>
              </Pressable>
            </HStack>
          ))}
        </HStack>
      ) : null}

      {/* Current level chips. */}
      {currentChildren.length > 0 ? (
        <VStack space="xs">{currentChildren.map(renderChip)}</VStack>
      ) : (
        <Box className="py-2">
          <Text className="text-typography-400 text-center" style={{ fontSize: 12 }}>
            {t('swipeFeed.treeThanks')}
          </Text>
        </Box>
      )}
    </VStack>
  );
};

export default InlineFeedbackTree;
