// FactChoiceBulkRow — "Add all (N)" / "Skip all" for ONE message's pending
// fact-choice group, or "Replace all" / "Keep all" / "Skip all" once any card
// in it is a replace card (owner ruling ux2).
//
// THE MIXED RULE: Replace all replaces on every replace card and ADDS every add
// card; Keep all adds every card and replaces nothing; Skip all dismisses all.
// Every card commits its preferred reading, as tapping its own button would.
//
// Placement is deliberate and differs from TopicPlanSaveAllRow: that row is
// thread-wide and therefore lives as fixed chrome above the composer, while a
// fact-choice group belongs to one assistant message. This row is emitted INLINE
// by deriveThreadItems, directly after the last pending card of its own group,
// so two groups in one thread cannot share one control.
//
// The verbs match the per-card buttons exactly (Add / Skip). A row saying
// "Accept" or "Reject" would name actions that appear nowhere else on screen.
//
// ONE read-modify-write for the whole group (resolveGroups), not N. N calls
// would be N store writes, N re-renders and N durable patches for one tap, and
// the fully-resolved rewrite would be evaluated against N-1 partial states
// instead of firing once at the end.

import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { commitFactChoices } from '@/lib/chat-tools/fact-commit';
import type { FactChoiceResolution } from '@/lib/chat-tools/fact-choice-resolution';
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import logger from '@/lib/logger';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { resolveGroups } from './fact-choice-actions';

export interface FactChoiceBulkRowProps {
  resultKey: string;
  /** The tool call's staged result. "Add all" is usually the FIRST resolution
   *  of the turn, which is exactly the case with no store entry yet. */
  baseResult: Record<string, unknown>;
  groups: {
    groupId: string;
    groupIndex: number;
    options: string[];
    questionnaireAttribute: string | null;
    topicSkillId: string | null;
    replaces: string | null;
  }[];
}

const FactChoiceBulkRow: React.FC<FactChoiceBulkRowProps> = ({
  resultKey,
  baseResult,
  groups,
}) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  // The deriver already filters to pending groups and only emits this row at
  // 2+, but the guard stays: a re-render mid-tap must not show a one-group row.
  if (groups.length < 2) return null;

  const hasReplace = groups.some((g) => g.replaces !== null);

  const handleAddAll = (mode: 'add' | 'replace' | 'keep' = 'add') => async () => {
    if (busy) return;
    setBusy(true);
    void hapticSuccess();
    try {
      // Each group commits the reading its own card currently shows selected —
      // which for an untouched card is `options[0]`, Mera's preferred reading,
      // exactly as tapping that card's Add would. A card the user changed the
      // radio on is not represented here; that is why the radio selection is a
      // per-card concern and Add-all is documented as "the preferred reading".
      const choices = groups.map((g) => ({
        statement: g.options[0],
        questionnaire: g.questionnaireAttribute
          ? { attribute: g.questionnaireAttribute }
          : undefined,
        // Per GROUP, not per batch: two facts accepted together can have been
        // routed to different guidelines.
        ...(g.topicSkillId ? { skillId: g.topicSkillId } : {}),
        // Only "Replace all" replaces. A missing target degrades to an add in
        // commitFactChoices, never to a lost fact.
        ...(mode === 'replace' && g.replaces ? { replaces: g.replaces } : {}),
      }));
      // ONE commitFactChoices call, so conflict detection runs against the same
      // pre-batch bank a single multi-fact turn always used and topic generation
      // makes one batch instead of N.
      const { savedFacts, conflicts } = await commitFactChoices(choices);

      // Map each saved fact back to the group that asked for it, by statement.
      const byStatement = new Map(savedFacts.map((f) => [f.statement, f]));
      const entries = groups.map((g) => {
        const saved = byStatement.get(g.options[0]);
        const resolution: FactChoiceResolution = {
          status: 'saved',
          statements: [g.options[0]],
          savedFacts: saved ? [saved] : [],
          // Conflicts are detected across the whole batch, so they are attached
          // to the group whose new fact raised them.
          conflicts: saved ? conflicts.filter((c) => c.newFactId === saved.id) : [],
          // Marks this group as batch-accepted, which is what makes the topics
          // land in ONE merged card after the group instead of N cards down the
          // thread. Recorded rather than inferred: the ordinary case of tapping
          // Add on each card in turn must keep its in-line cards.
          batch: true,
        };
        return { groupId: g.groupId, resolution };
      });
      resolveGroups(resultKey, entries, baseResult);
    } catch (err) {
      logger.error('[FactChoiceBulkRow] bulk accept failed', err, {
        resultKey,
        groups: groups.length,
        mode,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSkipAll = () => {
    if (busy) return;
    void hapticLight();
    // Nothing was written, so this needs no confirmation and no model turn —
    // unlike topic-plan "Discard all", which deletes facts and records a note
    // the model is told about. Skipping costs nothing and each line keeps its
    // own Undo.
    resolveGroups(
      resultKey,
      groups.map((g) => ({
        groupId: g.groupId,
        resolution: {
          status: 'dismissed' as const,
          options: g.options,
          questionnaireAttribute: g.questionnaireAttribute,
        },
      })),
      baseResult,
    );
  };

  return (
    <View style={styles.row} testID="fact-choice-bulk-row">
      <Button
        testID="fact-choice-skip-all"
        onPress={handleSkipAll}
        isDisabled={busy}
        className="rounded-full bg-background-100"
        size="sm"
        // 44pt iOS / 48dp Android minimum, enforced here rather than inherited:
        // gluestack's `sm` pill is shorter than both.
        style={styles.tapTarget}
        accessibilityLabel={t('factChoice.skipAllA11y', { count: groups.length })}
      >
        <ButtonText className="text-typography-700 text-sm">
          {t('factChoice.skipAll')}
        </ButtonText>
      </Button>
      {hasReplace ? (
        <>
          <Button
            testID="fact-choice-keep-all"
            onPress={handleAddAll('keep')}
            isDisabled={busy}
            className="rounded-full bg-primary-400"
            size="sm"
            style={styles.tapTarget}
            // TODO(ux2 splice): drop the casts once `_ux2-chat-bulk-fragments.json` lands.
            accessibilityLabel={t('factChoice.keepAllA11y' as 'factChoice.addAllA11y', { count: groups.length })}
          >
            <ButtonText className="text-white text-sm">
              {t('factChoice.keepAll' as 'factChoice.skipAll')}
            </ButtonText>
          </Button>
          <Button
            testID="fact-choice-replace-all"
            onPress={handleAddAll('replace')}
            isDisabled={busy}
            className="rounded-full bg-transparent border border-error-400"
            size="sm"
            style={styles.tapTarget}
            accessibilityLabel={t('factChoice.replaceAllA11y' as 'factChoice.addAllA11y', { count: groups.length })}
          >
            <ButtonText className="text-sm" style={styles.replaceText}>
              {t('factChoice.replaceAll' as 'factChoice.skipAll')}
            </ButtonText>
          </Button>
        </>
      ) : (
        <Button
          testID="fact-choice-add-all"
          onPress={handleAddAll('add')}
          isDisabled={busy}
          className="rounded-full bg-primary-400"
          size="sm"
          style={styles.tapTarget}
          accessibilityLabel={t('factChoice.addAllA11y', { count: groups.length })}
        >
          <ButtonText className="text-white text-sm">
            {t('factChoice.addAll', { count: groups.length })}
          </ButtonText>
        </Button>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  tapTarget: { minHeight: 48, paddingHorizontal: 18 },
  replaceText: { color: 'rgb(248, 113, 113)' },
});

export default FactChoiceBulkRow;
