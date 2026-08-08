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

import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { executeProposalActions } from '@/lib/chat-tools/proposal-handlers';
import { hapticSuccess } from '@/lib/haptics';
import type { ProposalAction, StagedProposal } from '@/lib/llm/types';
import { proposalRequiresUserChoice } from '@/lib/news-harness/core/proposals';
import {
  useFloatingChatIsGenerating,
  useFloatingChatProposal,
  useFloatingChatResolvedProposals,
  useFloatingChatStore,
} from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
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

export interface ActionRow {
  icon: keyof typeof MaterialIcons.glyphMap;
  labelKey: string;
  labelDefault?: string;
  /** Optional detail line(s) beneath the label. */
  detail?: string;
  /** Optional bold heading above the detail (feature-request title). */
  heading?: string;
  /**
   * Whether `heading` / `detail` are English PROSE that should be display-
   * translated into the reader's app language (see the block comment above
   * `actionToRow`). Opt-IN, deliberately: the default for an unknown row is to
   * show the literal string, because the rows that must not be translated are
   * the ones whose text is a machine value (a match pattern, a publication
   * name), and a new action type is more likely to carry one of those than to
   * carry prose.
   */
  translateHeading?: boolean;
  translateDetail?: boolean;
  /** Optional small pill rendered before the detail — currently the structured
   *  suppression KIND ("Category", "Publication", …). Absent for a plain
   *  keyword filter, whose label already says "phrase". */
  chip?: { key: string; default: string };
}

/** Display label for a structured suppression kind — deliberately the SAME keys
 *  the Not-interested screen uses, so a filter reads identically where it is
 *  confirmed and where it is later managed. `keyword` is absent on purpose: it
 *  is the default, and the row label already reads "a phrase". */
const SUPPRESSION_KIND_CHIPS: Record<string, { key: string; default: string }> = {
  category: { key: 'notInterested.kinds.category', default: 'Category' },
  event_type: { key: 'notInterested.kinds.event_type', default: 'Kind of story' },
  entity: { key: 'notInterested.kinds.entity', default: 'Person or thing' },
  publication: { key: 'notInterested.kinds.publication', default: 'Source' },
  place: { key: 'notInterested.kinds.place', default: 'Place' },
  topic: { key: 'notInterested.kinds.topic', default: 'Topic' },
};

/**
 * Maps a ProposalAction to its display row. Exported for the action-type
 * coverage test — a type that falls through to the guard renders a detail-less
 * "tune" row, which is a silent presentation bug, not a compile error.
 *
 * TRANSLATION POLICY (`translateHeading` / `translateDetail`). The agent writes
 * its conversational text in the reader's language but keeps every structured
 * payload English — see the LANGUAGE rule in
 * `lib/news-harness/article-feedback/agent-core.ts`. So the strings that reach
 * this card are English regardless of app language, and the row text is the ONLY
 * copy of them the reader ever sees. Those get display-translated.
 *
 * Three rows deliberately do NOT:
 *   - `set_publication_pref` → `publicationId` is an outlet's proper NAME;
 *   - `add_suppression` → `suppressionPattern` and
 *   - `retire_suppression` → `pattern` are literal MATCH strings.
 * Machine-translating any of those would tell the reader their filter matches a
 * Hindi phrase when it matches an English one, and would rename a publication
 * that is not renamed anywhere else in the app. An untranslated proper noun is a
 * smaller cost than a confidently wrong one.
 *
 * The translation is DISPLAY-ONLY and cannot leak into anything persisted:
 * `handleConfirm` hands `executeProposalActions` the ProposalAction OBJECTS, not
 * the rendered rows, so `action.label` / `action.searchText` / `topicText` reach
 * the executor exactly as the agent staged them.
 */
export function actionToRow(action: ProposalAction): ActionRow {
  switch (action.type) {
    case 'add_fact':
      return {
        icon: 'add-circle',
        labelKey: 'articleFeedback.actionAddFact',
        detail: action.statement,
        translateDetail: true,
      };
    case 'update_fact':
      return {
        icon: 'edit',
        labelKey: 'articleFeedback.actionUpdateFact',
        detail: action.new_statement,
        translateDetail: true,
      };
    case 'delete_fact':
      return { icon: 'remove-circle', labelKey: 'articleFeedback.actionDeleteFact' };
    case 'add_topics':
      return {
        icon: 'label',
        labelKey: 'articleFeedback.actionAddTopics',
        detail: action.topics.join(', '),
        translateDetail: true,
      };
    case 'remove_topics':
      return {
        icon: 'label-off',
        labelKey: 'articleFeedback.actionRemoveTopics',
        detail: action.topics.join(', '),
        translateDetail: true,
      };
    case 'submit_feature_request':
      // Both fields are English by schema ("summary: 2–4 sentence description,
      // English") because they are read by the Mera team, not stored as feed
      // signal — so the reader is the one person who needs them translated.
      return {
        icon: 'send',
        labelKey: 'articleFeedback.actionFeatureRequest',
        labelDefault: 'Send feature request to the Mera team',
        heading: action.title,
        detail: action.summary,
        translateHeading: true,
        translateDetail: true,
      };
    case 'track_story':
      // The scope label is the load-bearing choice, so render it as the bold
      // heading with "Follow story" as the small category line above it. This
      // reads cleanly when the card offers 3–4 scope pills to pick between.
      // DISPLAY-translated only. `action.label` is what gets persisted as the
      // followed story's name and `action.searchText` is what drives retrieval
      // against an English corpus — neither is read back from this row, so the
      // Hindi the reader sees never reaches either.
      return {
        icon: 'track-changes',
        labelKey: 'trackedStories.trackAction',
        labelDefault: 'Follow story',
        heading: action.label,
        translateHeading: true,
      };
    // -- Wave-9 rails-backed feed-tuning actions (the "less of this" choose-one
    //    alternatives) — each renders its own labelled row so the radio card is
    //    legible. --
    case 'set_topic_weight':
      return {
        icon: action.delta < 0 ? 'trending-down' : 'trending-up',
        labelKey:
          action.delta < 0
            ? 'articleFeedback.actionShowLessTopic'
            : 'articleFeedback.actionShowMoreTopic',
        labelDefault: action.delta < 0 ? 'Show less of a topic' : 'Show more of a topic',
        detail: action.topicText,
        translateDetail: true,
      };
    case 'add_negative_topic':
      return {
        icon: 'thumb-down',
        labelKey: 'articleFeedback.actionDownRank',
        labelDefault: 'Down-rank a topic',
        detail: action.topicText,
        translateDetail: true,
      };
    // FIX (source-pref v47): this row used to read "Adjust a publication" for
    // all three prefs, so boost and deprioritize differed only by having the
    // SAME icon — the card could not tell the user what Confirm was about to
    // do. Boosting and muting the same outlet are opposite outcomes; the label
    // now names the direction.
    case 'set_publication_pref':
      return {
        icon:
          action.publicationPref === 'mute'
            ? 'volume-off'
            : action.publicationPref === 'boost'
              ? 'trending-up'
              : 'trending-down',
        labelKey:
          action.publicationPref === 'mute'
            ? 'articleFeedback.actionPublicationMute'
            : action.publicationPref === 'boost'
              ? 'articleFeedback.actionPublicationBoost'
              : 'articleFeedback.actionPublicationDeprioritize',
        labelDefault:
          action.publicationPref === 'mute'
            ? 'Mute a publication'
            : action.publicationPref === 'boost'
              ? 'Show more from a publication'
              : 'Show less from a publication',
        // NOT translated: this is the outlet's NAME. It is the same string the
        // publication-preferences screen and the article meta row show, and
        // machine-translating a masthead invents an outlet that does not exist.
        detail: action.publicationId,
      };
    // source-pref v47 (D2/D6). The scope LABEL is the load-bearing thing the
    // user is agreeing to ("India"), so it is the detail line; the label names
    // the direction for the same reason as above.
    case 'set_source_scope_pref':
      return {
        icon: action.publicationPref === 'boost' ? 'public' : 'public-off',
        labelKey:
          action.publicationPref === 'boost'
            ? 'articleFeedback.actionSourceScopeBoost'
            : 'articleFeedback.actionSourceScopeDeprioritize',
        labelDefault:
          action.publicationPref === 'boost'
            ? 'Show more from sources in a country'
            : 'Show less from sources in a country',
        // A closed-vocabulary English COUNTRY name resolved by
        // `resolveCountryScope`. The persisted value is `scopeValue` (an ISO
        // code), so translating the label for display cannot drift the scope.
        detail: action.label,
        translateDetail: true,
      };
    case 'add_suppression':
      return {
        icon: 'block',
        labelKey: 'articleFeedback.actionSuppress',
        labelDefault: 'Filter out a phrase',
        // NOT translated: a literal MATCH string. Showing a Hindi rendering
        // would promise a filter the English-corpus matcher does not implement.
        detail: action.suppressionPattern,
        // A structured filter is a different promise from a keyword one (exact
        // field match vs "anywhere in the story"), so the card has to say which.
        ...(action.suppressionKind && SUPPRESSION_KIND_CHIPS[action.suppressionKind]
          ? { chip: SUPPRESSION_KIND_CHIPS[action.suppressionKind] }
          : {}),
      };
    case 'retire_suppression':
      return {
        icon: 'filter-alt-off',
        labelKey: 'articleFeedback.actionRetireSuppression',
        labelDefault: 'Remove a filter',
        // Empty on a resumed card — the sanitizer resolves `pattern` from our
        // own filter list and it is not echoed into the persisted tool result.
        // NOT translated, for the same reason as add_suppression: it is the
        // literal pattern, and it must read identically here and on the
        // Not-interested screen where the filter is later managed.
        detail: action.pattern,
      };
    case 'set_high_priority':
      return {
        icon: 'push-pin',
        labelKey: action.highPriority
          ? 'articleFeedback.actionPinTopic'
          : 'articleFeedback.actionUnpinTopic',
        labelDefault: action.highPriority ? 'Pin a topic' : 'Unpin a topic',
        detail: action.topicText,
        translateDetail: true,
      };
    case 'retire_topic':
      return {
        icon: 'do-not-disturb-on',
        labelKey: 'articleFeedback.actionRetireTopic',
        labelDefault: 'Retire a topic',
        detail: action.topicText,
        translateDetail: true,
      };
    case 'run_calibration':
      // The Confirm button on this row is the ONLY thing that recalibrates.
      return {
        icon: 'tune',
        labelKey: 'calibration.actionRecalibrate',
        labelDefault: 'Re-tune relevance scoring',
        detail: undefined,
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
  // Single-select: which alternative the user has picked (defaults to the first,
  // so Confirm is always meaningful). Only used when proposal.chooseOne.
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Shared with both agents' applyProposal (which REFUSE such a proposal) so the
  // "is this single-select?" reading cannot drift between the card and the model.
  const chooseOne = proposalRequiresUserChoice(proposal);

  // A "follow this story" proposal (every action is track_story, single or
  // multi-scope) gets its own header wording; other proposals keep the generic
  // "Proposed changes".
  const isTrackProposal =
    proposal.actions.length > 0 && proposal.actions.every((a) => a.type === 'track_story');

  const resolved = localResolved ?? resolvedProposals[proposal.id] ?? null;
  const isPending =
    resolved === null &&
    storeProposal !== null &&
    (storeProposal.id === proposal.id || isLast);

  const handleConfirm = async () => {
    if (isGenerating || isApplying) return;
    // Single-select applies EXACTLY the chosen alternative; otherwise all actions.
    const toApply = chooseOne
      ? [proposal.actions[selectedIndex] ?? proposal.actions[0]]
      : proposal.actions;
    setIsApplying(true);
    try {
      // The ONLY caller allowed to apply user-confirmed-only actions: this
      // runs from the Confirm button's onPress, i.e. a real tap.
      await executeProposalActions(toApply, { confirmedByUser: true });
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
  // Applied / cancelled is TERMINAL: the rows stop being choices, so they lose
  // their press affordance (already true) AND their full contrast (was not) —
  // otherwise the card keeps reading as interactive after the user confirmed.
  const isResolved = resolved !== null;
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

      {chooseOne && (
        <Text size="xs" style={styles.hint}>
          {t('articleFeedback.chooseOneHint', { defaultValue: 'Pick one option' })}
        </Text>
      )}

      {/* `explanation` / `expectedEffects` are NOT display-translated, unlike
          the action rows. They are the agent's own prose to the reader, and the
          LANGUAGE rule in agent-core makes conversational text follow the app
          language — so they should already arrive in Hindi. That is not proven
          (the prompt also hard-codes English sample sentences for the
          feature-request case), and translating text that is ALREADY in the
          target language is not a no-op here: translateText declares
          sourceLangCode 'en' unconditionally on iOS, so feeding it Hindi
          produces garbage rather than the same string back. Leaving them is the
          recoverable direction; confirm on-device before changing it. */}
      {proposal.explanation.length > 0 && (
        <Text size="sm" style={styles.explanation}>
          {proposal.explanation}
        </Text>
      )}

      <View
        testID="proposal-actions"
        style={[styles.actions, isResolved && styles.actionsResolved]}
      >
        {proposal.actions.map((action, idx) => {
          const row = actionToRow(action);
          const selected = chooseOne && idx === selectedIndex;
          const rowIcon: keyof typeof MaterialIcons.glyphMap = chooseOne
            ? selected
              ? 'radio-button-checked'
              : 'radio-button-unchecked'
            : row.icon;
          const body = (
            <>
              <MaterialIcons name={rowIcon} size={16} color={ACCENT} style={styles.actionIcon} />
              <View style={styles.actionBody}>
                <Text size="xs" bold style={styles.actionLabel}>
                  {row.labelDefault
                    ? t(row.labelKey as TKey, { defaultValue: row.labelDefault })
                    : t(row.labelKey as TKey)}
                </Text>
                {row.heading &&
                  (row.translateHeading ? (
                    <TranslatableDynamic
                      text={row.heading}
                      size="sm"
                      bold
                      style={styles.actionHeading}
                    />
                  ) : (
                    <Text size="sm" bold style={styles.actionHeading}>
                      {row.heading}
                    </Text>
                  ))}
                {row.chip && (
                  <View style={styles.chip}>
                    <Text size="xs" style={styles.chipText}>
                      {t(row.chip.key as TKey, { defaultValue: row.chip.default })}
                    </Text>
                  </View>
                )}
                {row.detail &&
                  (row.translateDetail ? (
                    <TranslatableDynamic
                      text={row.detail}
                      size="sm"
                      style={styles.actionDetail}
                    />
                  ) : (
                    <Text size="sm" style={styles.actionDetail}>
                      {row.detail}
                    </Text>
                  ))}
              </View>
            </>
          );
          if (chooseOne && isPending) {
            return (
              <Pressable
                key={idx}
                testID={`proposal-action-row-${idx}`}
                onPress={() => setSelectedIndex(idx)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                style={[styles.actionRow, styles.actionRowSelectable, selected && styles.actionRowSelected]}
              >
                {body}
              </Pressable>
            );
          }
          // Terminal state: no Pressable, no selection box (the radio icon above
          // already shows WHICH option was applied) — just a dimmed, explicitly
          // disabled row, so nothing on the card still reads as tappable.
          if (chooseOne && isResolved) {
            return (
              <View
                key={idx}
                testID={`proposal-action-row-${idx}`}
                accessibilityRole="radio"
                accessibilityState={{ selected, disabled: true }}
                style={styles.actionRow}
              >
                {body}
              </View>
            );
          }
          return (
            <View key={idx} testID={`proposal-action-row-${idx}`} style={styles.actionRow}>
              {body}
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
  hint: {
    color: 'rgb(180, 180, 180)',
    fontStyle: 'italic',
  },
  actions: {
    gap: 8,
  },
  // Same 0.5 dim the card uses for its expired state — the codebase's
  // "this control is no longer live" convention.
  actionsResolved: {
    opacity: 0.5,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  actionRowSelectable: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'transparent',
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  actionRowSelected: {
    borderColor: ACCENT,
    backgroundColor: 'rgba(231, 138, 83, 0.10)',
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
  chip: {
    alignSelf: 'flex-start',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(231, 138, 83, 0.5)',
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  chipText: {
    color: ACCENT,
    letterSpacing: 0.3,
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
