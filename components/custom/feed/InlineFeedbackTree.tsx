// InlineFeedbackTree — the Feed-tab feedback tree, rendered inside the card's
// inline feedback surface (CardFeedbackSurface) once a verdict exists. Every tap
// enriches the stored verdict row's path (onTreePathChanged); an `openChat` leaf
// escalates to the Mera chat (onInvokeMera). The tree content + gating come from
// the shared engine (like OR dislike root depending on the verdict).
//
// D16 — a TERMINAL leaf is no longer inert. It resolves the leaf's actions
// against the local context and applies them immediately through the same
// `useApplyLeafActions` (applyPersonaActions + Undo toast) the modal
// FeedbackTreeOverlay uses, then stamps the verdict row processed so the
// digest can never double-apply the same signal. Until then a verdict is
// provisional: it is written, shown unfilled, and discarded (see
// article-feedback-service's D15 header).
//
// Nudge leaves stay informational here (path recorded, surface closes) — they
// carry no persona actions on any surface. A seenOnly leaf is informational too
// but now says so out loud (acknowledgeSeenOnly): silent success on a surface
// that has just promised "your feed changes right away" reads as a dead button.

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useFeedbackTreeEngine } from '@/components/custom/feedback-tree/useFeedbackTreeEngine';
import { acknowledgeSeenOnly } from '@/components/custom/feedback-tree/acknowledge-seen-only';
import { applyLeafActions } from '@/components/custom/feedback-tree/apply-leaf-actions';
import { getVisitCountForPublication } from '@/lib/database/services/publication-visit-service';
import { getSuggestionFeedbackContext } from '@/lib/database/services/article-suggestion-service';
import { hapticLight, hapticMedium } from '@/lib/haptics';
import logger from '@/lib/logger';
import { resolveLeafActions, resolveTopicLabel } from '@/lib/news-harness/feedback-tree';
import type {
  FeedbackTreeNode,
  LocalFeedbackContext,
} from '@/lib/news-harness/feedback-tree';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import type { Verdict } from '@/lib/stores/feed-order-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = '#EDA77E';
const CHIP_BG = '#1e1e1e';
const CHIP_BORDER = '#333333';
const SELECTED_BG = 'rgba(237,167,126,0.18)';
/** Node whose leaves ask the user to weight a topic without ever naming it
 *  (the like-tree's "More about this topic" → "A lot more" / "A bit more").
 *  This is a well-known content id (mirrors the `findNode('not_important')`
 *  fast-path convention in FeedbackTreeOverlay) rather than a structural
 *  guess — the id is content the server/bundled-fallback own (see
 *  `feedback-tree-v1.ts` server-side, `feedback-tree-snapshot.ts` bundled),
 *  so a future re-shape of this submenu needs a matching update here anyway. */
const TOPIC_NAMED_NODE_ID = 'more_about_topic';

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
  /** Breadcrumb ROOT label — the parent panel's own title (e.g. "More like
   *  this" / "Less like this"), so the trail matches what the user just saw.
   *  Defaults to the verdict-derived panel title when omitted. */
  rootLabel?: string;
  /** Context for fields this component cannot derive because there is no local
   *  `article_suggestions` row — a standalone article on the detail screen,
   *  whose category / place come off the fetched article instead. Applied only
   *  where the derived value is absent; the local row always wins. */
  contextFallback?: Partial<LocalFeedbackContext>;
}

/** Builds the on-device gating/resolution context for a suggestion (async). */
async function buildLocalContext(
  suggestion: ForYouSuggestion,
  fallback?: Partial<LocalFeedbackContext>,
): Promise<LocalFeedbackContext> {
  const matchedTopics = suggestion.matchedTopics ?? [];
  let category: string | null = null;
  let clusterSize: number | null = null;
  let geoText: string | null = null;
  try {
    const fb = await getSuggestionFeedbackContext({
      suggestionId: suggestion._id,
      articleId: suggestion.articleId,
    });
    if (fb) {
      category = fb.category;
      clusterSize = fb.clusterSize ?? null;
      geoText = fb.geoText ?? null;
    }
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

  // The local row always wins; `fallback` only fills what it could not supply
  // (a standalone article has no row at all — see detail-feedback-context).
  const resolvedClusterSize = clusterSize ?? fallback?.clusterSize ?? null;
  const resolvedGeoText = geoText ?? fallback?.geoText ?? null;

  return {
    publicationName: suggestion.publication_name,
    countryCode: suggestion.country_code,
    articleTitle: suggestion.title_en,
    category: category ?? fallback?.category ?? null,
    eventType: suggestion.eventType ?? undefined,
    matchedTopics,
    publicationVisits,
    // Both were already on the suggestion row and simply never read here, which
    // gated out `nudge_browse_related` and no-op'd every `from_context_geo`
    // leaf ("More news from this place") on the feed too — not just on detail.
    ...(resolvedClusterSize != null ? { clusterSize: resolvedClusterSize } : {}),
    ...(resolvedGeoText ? { geoText: resolvedGeoText } : {}),
  };
}

export const InlineFeedbackTree: React.FC<InlineFeedbackTreeProps> = ({
  suggestion,
  verdict,
  onTreePathChanged,
  onInvokeMera,
  onLeafCommitted,
  initialPathIds,
  rootLabel,
  contextFallback,
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
    void buildLocalContext(suggestion, contextFallback).then((ctx) => {
      if (!cancelled) setContext(ctx);
    });
    return () => {
      cancelled = true;
    };
  }, [suggestion, contextFallback]);

  const engine = useFeedbackTreeEngine({
    active: true,
    root: verdict === 'like' ? 'like' : 'dislike',
    context,
  });
  const {
    tree,
    path,
    currentChildren,
    pathIds,
    descend,
    goToDepth,
    restorePath,
    findNode,
    hasVisibleChildren,
  } = engine;

  // The breadcrumb root: the parent panel's own title, so the trail matches
  // what the user just saw there — reuses the existing panel-title keys
  // (no new i18n key) rather than the unexplained generic "All".
  const defaultRootLabel = t(verdict === 'like' ? 'swipeFeed.moreLikeThis' : 'swipeFeed.lessLikeThis', {
    defaultValue: verdict === 'like' ? 'More like this' : 'Less like this',
  }) as string;
  const resolvedRootLabel = rootLabel ?? defaultRootLabel;

  // Selected-leaf styling (an actions/nudge/seenOnly leaf the user tapped).
  const [selectedLeafId, setSelectedLeafId] = useState<string | null>(null);
  // A destructive leaf that has been ARMED and is waiting for a second tap.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);


  // Resume a revisited card's stored path once the tree is loaded.
  useEffect(() => {
    if (!tree || !initialPathIds || initialPathIds.length === 0) return;
    restorePath(initialPathIds);
    const lastId = initialPathIds[initialPathIds.length - 1];
    const node = findNode(lastId);
    if (node && !hasVisibleChildren(node)) setSelectedLeafId(lastId);
    // Restore once per tree load; navigation thereafter is user-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]);

  // Names the matched topic into the "More about this topic" branch's label
  // (chip AND breadcrumb crumb, since both render via this same callback) so
  // its "A lot more" / "A bit more" leaves aren't asking the user to weight an
  // unnamed thing — which matters more now that those leaves really do move
  // the weight (D16). Falls back to the generic tree-supplied
  // label when there's nothing real to name (defensive: the node is normally
  // gated out via `has_matched_topics` in that case — see evaluateCondition).
  const label = useCallback(
    (node: FeedbackTreeNode) => {
      if (node.id === TOPIC_NAMED_NODE_ID) {
        const choice = resolveTopicLabel(context);
        if (choice) {
          return (
            choice.extraCount > 0
              ? t('feedbackTree.moreAboutTopicNamedWithCount', {
                  defaultValue: 'More about: {{topic}} and {{extra}} more',
                  topic: choice.text,
                  // NOT named `count` — i18next reserves that var name to
                  // select `_one`/`_other` PLURAL SUFFIXES on the key itself
                  // (looked up before the base key), which would silently
                  // 404 to defaultValue on locales that only ship the base
                  // key. `extra` carries the same value without engaging it.
                  extra: choice.extraCount,
                })
              : t('feedbackTree.moreAboutTopicNamed', {
                  defaultValue: 'More about: {{topic}}',
                  topic: choice.text,
                })
          ) as string;
        }
      }
      return t(node.labelKey, { defaultValue: node.labelDefault }) as string;
    },
    [t, context],
  );

  const handleSelect = useCallback(
    (node: FeedbackTreeNode) => {
      const nextIds = [...pathIds, node.id];
      // A node only counts as a submenu if descending reveals at least one
      // GATED-visible child — a node whose children are all filtered out by
      // `evaluateCondition` is effectively terminal (see hasVisibleChildren).
      const isBranch = hasVisibleChildren(node);

      if (isBranch) {
        hapticMedium();
        setSelectedLeafId(null);
        setConfirmingId(null);
        descend(node);
        onTreePathChanged(suggestion, verdict, nextIds);
        return;
      }

      // Leaf. openChat escalates to Mera.
      if (node.leaf?.openChat) {
        hapticMedium();
        onTreePathChanged(suggestion, verdict, nextIds);
        onInvokeMera(suggestion, verdict, nextIds);
        return;
      }

      // A DESTRUCTIVE leaf (`confirm`, e.g. "Never show this publication") must
      // not fire on a single tap now that leaves really apply — the modal tree
      // has always had an explicit confirm step, and D17's "presentation may
      // differ, semantics must not" cuts both ways. Tap-to-arm, tap-again-to-do:
      // the same chip, relabelled, with no new surface.
      if (node.leaf?.confirm && (node.leaf.actions?.length ?? 0) > 0 && confirmingId !== node.id) {
        hapticMedium();
        setConfirmingId(node.id);
        return;
      }
      setConfirmingId(null);

      hapticLight();
      setSelectedLeafId(node.id);
      onTreePathChanged(suggestion, verdict, nextIds);

      // A seenOnly leaf ("I've seen this already") changes NOTHING by design, so
      // it must not COMMIT: a filled thumb promises "this changed your persona",
      // and this leaf has nothing to promise. It says so out loud instead, and
      // the panel deliberately stays open — the honest next move is to let the
      // user pick a reason that WOULD change their feed.
      //
      // Gated on the DECLARED flag, not on `actions.length === 0` — that is also
      // true when a leaf's placeholders couldn't be resolved, and cheerfully
      // acknowledging THAT would be a different lie. See acknowledgeSeenOnly.
      if (node.leaf?.seenOnly) {
        void acknowledgeSeenOnly();
        return;
      }

      // Terminal (non-openChat) leaf — let the host settle + auto-advance.
      onLeafCommitted?.(suggestion, verdict, nextIds);

      // D16 — and APPLY it. `resolveLeafActions` returns [] for nudge /
      // seenOnly leaves and for any leaf whose placeholders the local context
      // can't fill, which is also the guard that keeps the DB/persona modules
      // out of the import graph until there is genuinely something to write.
      const actions = resolveLeafActions(node.leaf, context);
      if (actions.length === 0) return;
      // `applyLeafActions` also stamps the verdict row spent when something
      // lands, so "applied" and "processed" can't drift apart.
      void applyLeafActions(actions, label(node), {
        articleId: suggestion.articleId,
        sentiment: verdict,
      });
    },
    [
      pathIds,
      hasVisibleChildren,
      descend,
      onTreePathChanged,
      onInvokeMera,
      onLeafCommitted,
      suggestion,
      verdict,
      context,
      label,
      confirmingId,
    ],
  );

  const handleCrumb = useCallback(
    (depth: number) => {
      hapticLight();
      setSelectedLeafId(null);
      setConfirmingId(null);
      goToDepth(depth);
    },
    [goToDepth],
  );

  const breadcrumb = useMemo(() => path.map((n) => label(n)), [path, label]);

  if (!tree) return null;

  const renderChip = (node: FeedbackTreeNode) => {
    const isBranch = hasVisibleChildren(node);
    const selected = selectedLeafId === node.id;
    const arming = confirmingId === node.id;
    const chipLabel = arming
      ? (t('swipeFeed.tapAgainToConfirm', {
          defaultValue: 'Tap again to confirm',
        }) as string)
      : label(node);
    return (
      <Pressable
        key={node.id}
        testID={`feedback-tree-leaf-${node.id}`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={chipLabel}
        onPress={() => handleSelect(node)}
        className="rounded-2xl"
        style={{
          backgroundColor: selected || arming ? SELECTED_BG : CHIP_BG,
          borderColor: selected || arming ? ACCENT : CHIP_BORDER,
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
          <Text className="flex-1" style={{ color: '#FFFFFF', fontSize: 14, fontWeight: '600' }}>
            {chipLabel}
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
            accessibilityLabel={resolvedRootLabel}
            onPress={() => handleCrumb(0)}
          >
            <Text style={{ color: ACCENT, fontSize: 12, fontWeight: '700' }}>
              {resolvedRootLabel}
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
                  style={{ color: '#E5E5E5', fontSize: 12, fontWeight: '600' }}
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
          <Text className="text-center" style={{ color: '#E5E5E5', fontSize: 12 }}>
            {t('swipeFeed.treeThanks')}
          </Text>
        </Box>
      )}
    </VStack>
  );
};

export default InlineFeedbackTree;
