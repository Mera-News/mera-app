// ProposalCard — presentational confirm card for a persona change staged by the
// article-feedback agent's `proposeChanges` tool. Renders the explanation, one
// row per action, the expected effect, and (while pending) Confirm / Not-now
// buttons. Confirm runs the deterministic executor and resolves the proposal;
// there is no re-inference, so it works identically on the one-shot local path.
//
// Status reconciliation (see deriveThreadItems.ts): the staged proposal id is a
// nonce generated inside the agent — it does NOT equal the tool-call id — so a
// card cannot always match the store proposal by id. We therefore combine three
// signals, in priority order:
//   1. local state — this mount just ran Confirm/Cancel (authoritative for the
//      live session regardless of id matching);
//   2. resolvedProposals[id] — a terminal status recorded under a matching id
//      (works when the tool result echoed the id);
//   3. "am I the LAST proposal card AND does a store proposal exist" → pending;
//      otherwise expired (older superseded proposals, or in-memory store lost on
//      app restart, dim out with no buttons).

import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { executeProposalActions } from '@/lib/chat-tools/proposal-handlers';
import { hapticSuccess } from '@/lib/haptics';
import type { ProposalAction, StagedProposal } from '@/lib/llm/types';
import {
  useFloatingChatIsGenerating,
  useFloatingChatProposal,
  useFloatingChatResolvedProposals,
  useFloatingChatStore,
} from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)';

// Mirror FactCard's entering (fade + slide + slight scale) so a freshly-staged
// proposal lands with the same motion vocabulary as the fact cards.
function proposalCardEntering() {
  'worklet';
  const duration = 280;
  return {
    initialValues: {
      opacity: 0,
      transform: [{ translateY: 12 }, { scale: 0.97 }],
    },
    animations: {
      opacity: withTiming(1, { duration }),
      transform: [
        { translateY: withTiming(0, { duration }) },
        { scale: withTiming(1, { duration }) },
      ],
    },
  };
}

export interface ProposalCardProps {
  proposal: StagedProposal;
  /** True when this is the newest proposal card in the thread (see status doc). */
  isLast: boolean;
}

interface ActionRow {
  icon: keyof typeof MaterialIcons.glyphMap;
  labelKey: string;
  labelDefault?: string;
  /** Optional detail line(s) beneath the label. */
  detail?: string;
  /** Optional bold heading above the detail (feature-request title). */
  heading?: string;
}

/** Maps a ProposalAction to its display row. */
function actionToRow(action: ProposalAction): ActionRow {
  switch (action.type) {
    case 'add_fact':
      return { icon: 'add-circle', labelKey: 'articleFeedback.actionAddFact', detail: action.statement };
    case 'update_fact':
      return {
        icon: 'edit',
        labelKey: 'articleFeedback.actionUpdateFact',
        detail: action.new_statement,
      };
    case 'delete_fact':
      return { icon: 'remove-circle', labelKey: 'articleFeedback.actionDeleteFact' };
    case 'add_topics':
      return {
        icon: 'label',
        labelKey: 'articleFeedback.actionAddTopics',
        detail: action.topics.join(', '),
      };
    case 'remove_topics':
      return {
        icon: 'label-off',
        labelKey: 'articleFeedback.actionRemoveTopics',
        detail: action.topics.join(', '),
      };
    case 'submit_feature_request':
      return {
        icon: 'send',
        labelKey: 'articleFeedback.actionFeatureRequest',
        labelDefault: 'Send feature request to the Mera team',
        heading: action.title,
        detail: action.summary,
      };
    case 'track_story':
      return {
        icon: 'track-changes',
        labelKey: 'trackedStories.trackAction',
        labelDefault: 'Follow story',
        detail: action.trackText,
      };
    default:
      // Exhaustiveness guard — a future action type still renders a bare row.
      return { icon: 'tune', labelKey: 'articleFeedback.proposalTitle' };
  }
}

const ProposalCard: React.FC<ProposalCardProps> = ({ proposal, isLast }) => {
  const { t } = useTranslation();
  // Action label keys are resolved dynamically; casting to a single known-valid
  // key literal satisfies the typed-`t` overloads without widening the arg type.
  // (All keys are valid at runtime — `actionFeatureRequest` may still be landing
  // via the concurrent i18n change, hence the defaultValue fallback.)
  type TKey = 'articleFeedback.proposalTitle';
  const storeProposal = useFloatingChatProposal();
  const resolvedProposals = useFloatingChatResolvedProposals();
  const isGenerating = useFloatingChatIsGenerating();
  const [localResolved, setLocalResolved] = useState<'applied' | 'cancelled' | null>(null);
  const [isApplying, setIsApplying] = useState(false);

  // A pure "follow this story" proposal (single track_story action) gets its own
  // header wording; every other proposal keeps the generic "Proposed changes".
  const isTrackProposal =
    proposal.actions.length === 1 && proposal.actions[0].type === 'track_story';

  const resolved = localResolved ?? resolvedProposals[proposal.id] ?? null;
  const isPending =
    resolved === null &&
    storeProposal !== null &&
    (storeProposal.id === proposal.id || isLast);

  const handleConfirm = async () => {
    if (isGenerating || isApplying) return;
    setIsApplying(true);
    try {
      await executeProposalActions(proposal.actions);
    } finally {
      setIsApplying(false);
    }
    setLocalResolved('applied');
    useFloatingChatStore.getState().resolveProposal('applied');
    void hapticSuccess();
  };

  const handleCancel = () => {
    setLocalResolved('cancelled');
    useFloatingChatStore.getState().resolveProposal('cancelled');
  };

  const dimmed = !isPending && resolved === null; // expired
  const confirmDisabled = isGenerating || isApplying;

  return (
    <Animated.View
      entering={proposalCardEntering}
      style={[styles.card, dimmed && styles.cardDimmed]}
    >
      <View style={styles.headerRow}>
        <MaterialIcons
          name={isTrackProposal ? 'track-changes' : 'auto-fix-high'}
          size={18}
          color={ACCENT}
        />
        <Text size="sm" bold style={styles.title}>
          {isTrackProposal
            ? t('trackedStories.trackProposalTitle', { defaultValue: 'Follow this story?' })
            : t('articleFeedback.proposalTitle')}
        </Text>
      </View>

      {proposal.explanation.length > 0 && (
        <Text size="sm" style={styles.explanation}>
          {proposal.explanation}
        </Text>
      )}

      <View style={styles.actions}>
        {proposal.actions.map((action, idx) => {
          const row = actionToRow(action);
          return (
            <View key={idx} style={styles.actionRow}>
              <MaterialIcons name={row.icon} size={16} color={ACCENT} style={styles.actionIcon} />
              <View style={styles.actionBody}>
                <Text size="xs" bold style={styles.actionLabel}>
                  {row.labelDefault
                    ? t(row.labelKey as TKey, { defaultValue: row.labelDefault })
                    : t(row.labelKey as TKey)}
                </Text>
                {row.heading && (
                  <Text size="sm" bold style={styles.actionHeading}>
                    {row.heading}
                  </Text>
                )}
                {row.detail && (
                  <Text size="sm" style={styles.actionDetail}>
                    {row.detail}
                  </Text>
                )}
              </View>
            </View>
          );
        })}
      </View>

      {proposal.expectedEffects.length > 0 && (
        <Text size="xs" style={styles.effects}>
          <Text size="xs" bold style={styles.effectsLabel}>
            {t('articleFeedback.expectedEffects')}:{' '}
          </Text>
          {proposal.expectedEffects}
        </Text>
      )}

      {isPending && (
        <View style={styles.buttonRow}>
          <Button
            onPress={handleCancel}
            className="flex-1 rounded-full bg-background-100"
            size="sm"
          >
            <ButtonText className="text-typography-700 text-sm">
              {t('articleFeedback.proposalCancel')}
            </ButtonText>
          </Button>
          <Button
            onPress={handleConfirm}
            isDisabled={confirmDisabled}
            className="flex-1 rounded-full bg-primary-400"
            size="sm"
          >
            <ButtonText className="text-white text-sm">
              {t('articleFeedback.proposalConfirm')}
            </ButtonText>
          </Button>
        </View>
      )}

      {resolved !== null && (
        <View style={styles.statusRow}>
          <MaterialIcons
            name={resolved === 'applied' ? 'check-circle' : 'cancel'}
            size={16}
            color={resolved === 'applied' ? ACCENT : 'rgb(150, 150, 150)'}
          />
          <Text size="xs" style={styles.statusText}>
            {resolved === 'applied'
              ? t('articleFeedback.proposalApplied')
              : t('articleFeedback.proposalCancelled')}
          </Text>
        </View>
      )}

      {dimmed && (
        <Text size="xs" style={styles.expiredText}>
          {t('articleFeedback.proposalExpired')}
        </Text>
      )}
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(231, 138, 83, 0.08)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ACCENT,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  cardDimmed: {
    opacity: 0.5,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    color: ACCENT,
  },
  explanation: {
    color: 'rgb(210, 210, 210)',
  },
  actions: {
    gap: 8,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  actionIcon: {
    marginTop: 2,
  },
  actionBody: {
    flex: 1,
    gap: 2,
  },
  actionLabel: {
    color: ACCENT,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  actionHeading: {
    color: 'rgb(220, 220, 220)',
  },
  actionDetail: {
    color: 'rgb(193, 193, 193)',
  },
  effects: {
    color: 'rgb(180, 180, 180)',
  },
  effectsLabel: {
    color: 'rgb(200, 200, 200)',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 2,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusText: {
    color: 'rgb(180, 180, 180)',
  },
  expiredText: {
    color: 'rgb(140, 140, 140)',
    fontStyle: 'italic',
  },
});

export default ProposalCard;
