// FeedbackTreeOverlay — the SERVER-OWNED feedback tree, rendered as a dimming
// overlay over the article card. Opening it dims the underlying content and
// floats high-contrast option chips; picking a leaf resolves it to concrete
// persona mutations, applies them optimistically (shared `applyLeafActions`),
// and shows an Undo toast. Destructive leaves (`confirm`, e.g. mute-publication)
// get an in-overlay confirm step first.
//
// D17 — it serves BOTH verdicts now. `root` selects the tree; a thumbs-UP on
// the actions surfaces used to open nothing at all, so the like tree (which
// carries real boost/weight actions) never ran. Presentation differs from the
// Feed's inline surface; the SEMANTICS are the same shared path.
//
// Content (branch labels, icons, gating, actions) is 100% owned by the fetched
// tree (feedback-tree-service, bundled fallback). Only the CHROME here is local.

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { applyLeafActions } from '@/components/custom/feedback-tree/apply-leaf-actions';
import { hapticLight, hapticMedium } from '@/lib/haptics';
import {
  resolveLeafActions,
  type FeedbackTreeNode,
  type LocalFeedbackContext,
} from '@/lib/news-harness/feedback-tree';
import { useFeedbackTreeEngine } from '@/components/custom/feedback-tree/useFeedbackTreeEngine';
import type { ChatContext } from '@/lib/stores/floating-chat-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from 'react-native';

const ACCENT = '#EDA77E';
const CHIP_BG = '#2a2a2a';
const CHIP_BORDER = '#3f3f3f';

interface FeedbackTreeOverlayProps {
  visible: boolean;
  onClose: () => void;
  /** On-device context for gating + placeholder resolution. */
  context: LocalFeedbackContext;
  /** Chat handoff target for `openChat` leaves. */
  chatContext: ChatContext;
  /** Initial message auto-sent when a leaf escalates INTO chat. */
  chatMessage: string;
  /** Which tree to show. Defaults to 'dislike' (the historical behavior). */
  root?: 'like' | 'dislike';
  /** A TERMINAL leaf was picked — the tapped node-id path plus how many persona
   *  actions it actually applied. The host persists the path onto the stored
   *  verdict row, which is what turns a provisional thumb into a committed one
   *  (D15), and stamps the row processed when `appliedCount > 0` so the digest
   *  can't apply a second helping (D16). Fires for every terminal flavor —
   *  nudge / seenOnly leaves report 0. */
  onLeafPicked?: (pathIds: string[], appliedCount: number) => void;
}

/** i18n chrome helper — always supplies an English default so it renders pre-merge. */
function useChrome() {
  const { t } = useTranslation();
  return useCallback(
    (key: string, def: string, vars?: Record<string, unknown>) =>
      t(`feedbackTree.${key}`, { defaultValue: def, ...vars }) as string,
    [t],
  );
}

export const FeedbackTreeOverlay: React.FC<FeedbackTreeOverlayProps> = ({
  visible,
  onClose,
  context,
  chatContext,
  chatMessage,
  root = 'dislike',
  onLeafPicked,
}) => {
  const { t } = useTranslation();
  const c = useChrome();
  const toast = useToast();

  // Tree navigation (fetch + root selection + gated descent) lives in the shared
  // engine; the overlay keeps ONLY its chrome state below.
  const { path, pathIds, currentChildren, findNode, hasVisibleChildren, descend, backtrack } =
    useFeedbackTreeEngine({ active: visible, root, context });

  // The one-tap fast path ("Not that important") is a DISLIKE affordance — the
  // like tree has no equivalent, so it opens straight onto its options.
  const [browsing, setBrowsing] = useState(root === 'like');
  // Pending destructive confirm.
  const [confirming, setConfirming] = useState<FeedbackTreeNode | null>(null);

  // Reset the overlay-local chrome whenever it opens (the engine resets the path).
  useEffect(() => {
    if (!visible) return;
    setBrowsing(root === 'like');
    setConfirming(null);
  }, [visible, root]);

  const label = useCallback(
    (node: FeedbackTreeNode) => t(node.labelKey, { defaultValue: node.labelDefault }) as string,
    [t],
  );

  const fastPathNode = useMemo(() => findNode('not_important'), [findNode]);

  // ---- Toasts --------------------------------------------------------------

  const showInfoToast = useCallback(
    (title: string, body?: string) => {
      toast.show({
        placement: 'bottom',
        duration: 2500,
        render: () => (
          <Toast action="info" variant="solid">
            <VStack>
              <ToastTitle>{title}</ToastTitle>
              {body ? <ToastDescription>{body}</ToastDescription> : null}
            </VStack>
          </Toast>
        ),
      });
    },
    [toast],
  );

  // ---- Leaf handling -------------------------------------------------------

  const performLeaf = useCallback(
    (node: FeedbackTreeNode) => {
      const leaf = node.leaf;
      if (!leaf) return;

      // Escalate into the Mera chat.
      if (leaf.openChat) {
        onClose();
        useFloatingChatStore.getState().openArticleFeedback(chatContext, chatMessage);
        return;
      }

      // Every non-openChat leaf is terminal — tell the host so it can persist
      // the tapped path onto the verdict row (D15's commit discriminator).
      const leafPath = [...pathIds, node.id];

      // Nudge — a SUGGESTION, not a persona mutation.
      if (leaf.nudge) {
        onLeafPicked?.(leafPath, 0);
        onClose();
        if (leaf.nudge === 'subscribe') {
          showInfoToast(
            c('nudgeSubscribe', 'Subscribing unlocks full articles', {
              publication: context.publicationName ?? '',
            }),
          );
        } else {
          showInfoToast(c('nudgeBrowse', 'Look for related coverage from other sources'));
        }
        return;
      }

      // "I've seen this" — acknowledge only.
      if (leaf.seenOnly) {
        onLeafPicked?.(leafPath, 0);
        onClose();
        showInfoToast(c('seenAck', "Got it — we'll show fewer you've seen"));
        return;
      }

      // Concrete persona mutations.
      const actions = resolveLeafActions(leaf, context);
      onClose();
      if (actions.length === 0) {
        onLeafPicked?.(leafPath, 0);
        showInfoToast(c('thanks', 'Thanks for the feedback'));
        return;
      }
      void applyLeafActions(actions, label(node)).then((applied) => {
        onLeafPicked?.(leafPath, applied);
      });
    },
    [onClose, chatContext, chatMessage, context, c, showInfoToast, label, onLeafPicked, pathIds],
  );

  const onSelect = useCallback(
    (node: FeedbackTreeNode) => {
      hapticMedium();
      if (node.children && node.children.length > 0) {
        descend(node);
        return;
      }
      // Destructive leaf → confirm first.
      if (node.leaf?.confirm && (node.leaf.actions?.length ?? 0) > 0) {
        setConfirming(node);
        return;
      }
      performLeaf(node);
    },
    [performLeaf, descend],
  );

  const goBack = useCallback(() => {
    hapticLight();
    if (confirming) {
      setConfirming(null);
      return;
    }
    if (path.length > 0) {
      backtrack();
      return;
    }
    if (browsing) {
      setBrowsing(false);
      return;
    }
    onClose();
  }, [confirming, path.length, browsing, onClose, backtrack]);

  if (!visible) return null;

  const atEntry = path.length === 0 && !browsing && !confirming;
  const contextTitle = context.articleTitle?.trim();

  // ---- Render --------------------------------------------------------------

  const renderChip = (node: FeedbackTreeNode) => (
    <Pressable
      key={node.id}
      accessibilityRole="button"
      accessibilityLabel={label(node)}
      onPress={() => onSelect(node)}
      className="rounded-2xl"
      style={{ backgroundColor: CHIP_BG, borderColor: CHIP_BORDER, borderWidth: 1 }}
    >
      <HStack className="items-center px-4 py-3" space="md">
        {node.icon ? (
          <MaterialIcons
            name={node.icon as keyof typeof MaterialIcons.glyphMap}
            size={20}
            color={ACCENT}
          />
        ) : (
          <MaterialIcons name="chevron-right" size={20} color={ACCENT} />
        )}
        <Text className="flex-1 text-typography-0" style={{ fontSize: 15, fontWeight: '600' }}>
          {label(node)}
        </Text>
        {hasVisibleChildren(node) ? (
          <MaterialIcons name="arrow-forward-ios" size={14} color="#8a8a8a" />
        ) : null}
      </HStack>
    </Pressable>
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={goBack} statusBarTranslucent>
      {/* Dim scrim over the card/screen — tap to dismiss. */}
      <Pressable
        accessibilityLabel={c('dismiss', 'Dismiss')}
        onPress={onClose}
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' }}
      >
        {/* Panel — stop propagation so taps inside don't dismiss. */}
        <Pressable onPress={() => {}} style={{ width: '100%' }}>
          <Box
            className="rounded-t-3xl px-4 pb-8 pt-4"
            style={{ backgroundColor: '#151515', borderTopColor: '#2a2a2a', borderTopWidth: 1 }}
          >
            {/* Header: back + context strip. */}
            <HStack className="items-center pb-3" space="sm">
              {!atEntry ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={c('back', 'Back')}
                  onPress={goBack}
                  className="rounded-full p-1"
                >
                  <MaterialIcons name="arrow-back" size={22} color={ACCENT} />
                </Pressable>
              ) : null}
              <VStack className="flex-1">
                <Text className="text-typography-0" style={{ fontSize: 16, fontWeight: '700' }}>
                  {c('title', 'Tell us more')}
                </Text>
                {contextTitle ? (
                  <Text className="text-typography-400" numberOfLines={1} style={{ fontSize: 12 }}>
                    {c('contextFor', 'About: {{title}}', { title: contextTitle })}
                  </Text>
                ) : null}
              </VStack>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={c('dismiss', 'Dismiss')}
                onPress={onClose}
                className="rounded-full p-1"
              >
                <MaterialIcons name="close" size={22} color="#8a8a8a" />
              </Pressable>
            </HStack>

            {confirming ? (
              // Destructive confirm step.
              <VStack space="md" className="pt-1">
                <Text className="text-typography-0" style={{ fontSize: 15, fontWeight: '700' }}>
                  {c('confirmMuteTitle', 'Never show this publication?')}
                </Text>
                <Text className="text-typography-400" style={{ fontSize: 13 }}>
                  {c(
                    'confirmMuteBody',
                    "You won't see articles from {{publication}} again. You can undo this anytime.",
                    { publication: context.publicationName ?? 'this publication' },
                  )}
                </Text>
                <HStack space="sm" className="pt-1">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={c('cancel', 'Cancel')}
                    onPress={goBack}
                    className="flex-1 items-center rounded-2xl py-3"
                    style={{ backgroundColor: CHIP_BG, borderColor: CHIP_BORDER, borderWidth: 1 }}
                  >
                    <Text className="text-typography-0" style={{ fontWeight: '600' }}>
                      {c('cancel', 'Cancel')}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={c('confirm', 'Confirm')}
                    onPress={() => {
                      const node = confirming;
                      setConfirming(null);
                      performLeaf(node);
                    }}
                    className="flex-1 items-center rounded-2xl py-3"
                    style={{ backgroundColor: ACCENT }}
                  >
                    <Text style={{ color: '#1a1a1a', fontWeight: '700' }}>
                      {c('confirm', 'Confirm')}
                    </Text>
                  </Pressable>
                </HStack>
              </VStack>
            ) : atEntry ? (
              // Entry / fast-path: one-tap "not important" + descend.
              <VStack space="sm" className="pt-1">
                {fastPathNode ? renderChip(fastPathNode) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={c('tellMore', 'Tell me more')}
                  onPress={() => {
                    hapticMedium();
                    setBrowsing(true);
                  }}
                  className="rounded-2xl"
                  style={{ borderColor: ACCENT, borderWidth: 1.5 }}
                >
                  <HStack className="items-center px-4 py-3" space="md">
                    <MaterialIcons name="more-horiz" size={20} color={ACCENT} />
                    <Text className="flex-1" style={{ color: ACCENT, fontSize: 15, fontWeight: '700' }}>
                      {c('tellMore', 'Tell me more')}
                    </Text>
                  </HStack>
                </Pressable>
              </VStack>
            ) : (
              // Branch level.
              <VStack space="sm" className="pt-1">
                {currentChildren.length > 0 ? (
                  currentChildren.map(renderChip)
                ) : (
                  <Text className="text-typography-400 py-4 text-center">
                    {c('empty', 'No options here')}
                  </Text>
                )}
              </VStack>
            )}
          </Box>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

export default FeedbackTreeOverlay;
