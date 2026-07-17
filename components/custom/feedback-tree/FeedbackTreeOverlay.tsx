// FeedbackTreeOverlay — the SERVER-OWNED dislike/feedback tree, rendered as a
// dimming overlay over the article card. Opening it dims the underlying content
// and floats high-contrast option chips; picking a leaf resolves it to concrete
// persona mutations (via the Wave-9 `applyPersonaActions` dispatcher), applies
// them optimistically, and shows an Undo toast. Destructive leaves (`confirm`,
// e.g. mute-publication) get an in-overlay confirm step first.
//
// Content (branch labels, icons, gating, actions) is 100% owned by the fetched
// tree (feedback-tree-service, bundled fallback). Only the CHROME here is local.

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { applyPersonaActions } from '@/lib/database/services/persona-action-executor';
import { revertChange } from '@/lib/database/services/persona-change-log-service';
import { hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import logger from '@/lib/logger';
import {
  evaluateCondition,
  resolveLeafActions,
  type FeedbackTree,
  type FeedbackTreeNode,
  type LocalFeedbackContext,
  type ResolvedPersonaAction,
} from '@/lib/news-harness/feedback-tree';
import {
  getFeedbackTree,
  refreshFeedbackTree,
} from '@/lib/services/feedback-tree-service';
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
}) => {
  const { t } = useTranslation();
  const c = useChrome();
  const toast = useToast();

  const [tree, setTree] = useState<FeedbackTree | null>(null);
  // Descended branch nodes (empty = entry/fast-path view unless `browsing`).
  const [path, setPath] = useState<FeedbackTreeNode[]>([]);
  const [browsing, setBrowsing] = useState(false);
  // Pending destructive confirm.
  const [confirming, setConfirming] = useState<FeedbackTreeNode | null>(null);

  // Load the tree + kick a throttled refresh whenever the overlay opens.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setPath([]);
    setBrowsing(false);
    setConfirming(null);
    getFeedbackTree()
      .then((tr) => {
        if (!cancelled) setTree(tr);
      })
      .catch((err) =>
        logger.captureException(err, { tags: { component: 'FeedbackTreeOverlay', method: 'load' } }),
      );
    void refreshFeedbackTree();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const label = useCallback(
    (node: FeedbackTreeNode) => t(node.labelKey, { defaultValue: node.labelDefault }) as string,
    [t],
  );

  /** Find a leaf node by id anywhere in the tree (for the fast-path chip). */
  const findNode = useCallback(
    (id: string): FeedbackTreeNode | null => {
      const walk = (nodes: FeedbackTreeNode[]): FeedbackTreeNode | null => {
        for (const n of nodes) {
          if (n.id === id) return n;
          if (n.children) {
            const hit = walk(n.children);
            if (hit) return hit;
          }
        }
        return null;
      };
      return tree ? walk(tree.root) : null;
    },
    [tree],
  );

  const fastPathNode = useMemo(() => findNode('not_important'), [findNode]);

  // Children visible at the current level, gated by evaluateCondition.
  const currentChildren = useMemo(() => {
    if (!tree) return [];
    const level = path.length > 0 ? (path[path.length - 1].children ?? []) : tree.root;
    return level.filter((n) => evaluateCondition(n.visibleIf, context));
  }, [tree, path, context]);

  // ---- Toasts --------------------------------------------------------------

  const showUndoToast = useCallback(
    (summary: string, changeLogIds: string[]) => {
      toast.show({
        placement: 'bottom',
        duration: 6000,
        render: ({ id }: { id: string }) => (
          <Toast nativeID={`fbt-${id}`} action="success" variant="solid">
            <HStack className="flex-1 items-center justify-between" space="md">
              <VStack className="flex-1">
                <ToastTitle>{c('appliedTitle', 'Got it — feed updated')}</ToastTitle>
                {summary ? <ToastDescription>{summary}</ToastDescription> : null}
              </VStack>
              {changeLogIds.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={c('undo', 'Undo')}
                  onPress={() => {
                    void (async () => {
                      hapticLight();
                      for (const cid of changeLogIds) {
                        try {
                          await revertChange(cid);
                        } catch (err) {
                          logger.captureException(err, {
                            tags: { component: 'FeedbackTreeOverlay', method: 'undo' },
                          });
                        }
                      }
                      toast.close(id);
                      toast.show({
                        placement: 'bottom',
                        duration: 2000,
                        render: () => (
                          <Toast action="info" variant="solid">
                            <ToastTitle>{c('undoneTitle', 'Change undone')}</ToastTitle>
                          </Toast>
                        ),
                      });
                    })();
                  }}
                >
                  <Text style={{ color: '#1a1a1a', fontWeight: '700' }}>{c('undo', 'Undo')}</Text>
                </Pressable>
              ) : null}
            </HStack>
          </Toast>
        ),
      });
    },
    [toast, c],
  );

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

  const applyAndOfferUndo = useCallback(
    async (actions: ResolvedPersonaAction[], summary: string) => {
      hapticSuccess();
      // ResolvedPersonaAction is structurally a PersonaAction subset.
      const results = await applyPersonaActions(actions, 'feedback');
      const changeLogIds = results
        .filter((r) => r.applied && r.changeLogId)
        .map((r) => r.changeLogId as string);
      showUndoToast(summary, changeLogIds);
    },
    [showUndoToast],
  );

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

      // Nudge — a SUGGESTION, not a persona mutation.
      if (leaf.nudge) {
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
        onClose();
        showInfoToast(c('seenAck', "Got it — we'll show fewer you've seen"));
        return;
      }

      // Concrete persona mutations.
      const actions = resolveLeafActions(leaf, context);
      onClose();
      if (actions.length === 0) {
        showInfoToast(c('thanks', 'Thanks for the feedback'));
        return;
      }
      void applyAndOfferUndo(actions, label(node));
    },
    [onClose, chatContext, chatMessage, context, c, showInfoToast, applyAndOfferUndo, label],
  );

  const onSelect = useCallback(
    (node: FeedbackTreeNode) => {
      hapticMedium();
      if (node.children && node.children.length > 0) {
        setPath((p) => [...p, node]);
        return;
      }
      // Destructive leaf → confirm first.
      if (node.leaf?.confirm && (node.leaf.actions?.length ?? 0) > 0) {
        setConfirming(node);
        return;
      }
      performLeaf(node);
    },
    [performLeaf],
  );

  const goBack = useCallback(() => {
    hapticLight();
    if (confirming) {
      setConfirming(null);
      return;
    }
    if (path.length > 0) {
      setPath((p) => p.slice(0, -1));
      return;
    }
    if (browsing) {
      setBrowsing(false);
      return;
    }
    onClose();
  }, [confirming, path.length, browsing, onClose]);

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
        {node.children && node.children.length > 0 ? (
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
