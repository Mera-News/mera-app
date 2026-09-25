// FactChoiceCard — propose-before-save. Mera OFFERS readings; nothing exists yet.
//
// This card is the step that used to be missing. `saveExtractedFacts` wrote the
// fact and fired topic generation before returning, so the TopicPlanCard that
// followed was an undo, not a confirmation — and a misread input was already a
// fact by the time the user saw it. ("I'm interested in sporting football club"
// became "Interested in sporting a football club": one inserted article decided
// that `sporting` was a verb, and topic generation, left with no entity, fell
// back to the user's city.)
//
// NOTHING IS WRITTEN UNTIL A TAP. The commit runs `commitFactChoices`, which is
// the old handler's body — same `addFact` with the same questionnaire argument,
// same conflict detection, same topic-generation trigger — and then REWRITES the
// tool result so the fact card, conflict cards and TopicPlanCard downstream all
// derive exactly as they did before. That rewrite is why this card needs no
// changes anywhere in the emission logic.
//
// Deliberately NOT built on ProposalCard: `forcedExtractionTools()` returns []
// while a staged proposal exists, and facts are extracted on nearly every turn,
// so routing this through the proposal slot would disable the forced-extraction
// safety net for the whole pending window.

import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Button, ButtonText } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { commitFactChoices } from '@/lib/chat-tools/fact-commit';
import { getFacts } from '@/lib/database/services/fact-service';
import { getByFact } from '@/lib/database/services/topic-service';
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import { attributeKey, isLocationKey, mayReplaceKey } from '@/lib/mera-harness';
import logger from '@/lib/logger';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { resolveGroup } from './fact-choice-actions';
import Animated, { withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)';

/**
 * Would keeping both facts leave the persona contradicting itself? Two home
 * facts do (two current homes); two facts under the very same attribute do.
 * The key PREFIX alone is too coarse here: "background: country of origin"
 * and "background: origin and current residence" share it and can both be
 * true, which is exactly the owner's Keep both case.
 */
function contradicts(a: string | null, b: string | null): boolean {
  if (isLocationKey(a) && isLocationKey(b)) return true;
  const norm = (x: string | null) => (x ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return norm(a) === norm(b);
}
// The red already used by the blocked banner in ChatThread. Paired with the
// word "Replace" and the no-undo sentence: never colour alone.
const DESTRUCTIVE = '#F87171';
// The overlap label on a Keep both card: readable (~9:1 on the card) and
// deliberately not the destructive tint.
const NEUTRAL_LABEL = 'rgb(200, 200, 200)';

function cardEntering() {
  'worklet';
  const duration = 280;
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 12 }, { scale: 0.97 }] },
    animations: {
      opacity: withTiming(1, { duration }),
      transform: [{ translateY: withTiming(0, { duration }) }, { scale: withTiming(1, { duration }) }],
    },
  };
}

export interface FactChoiceCardProps {
  /** `${messageId}::${toolCallIndex}` — the tool result this group lives in. */
  resultKey: string;
  /** The tool call's staged result. The store holds overrides only, so the
   *  first tap of a turn has nothing to merge into without this. */
  baseResult: Record<string, unknown>;
  groupIndex: number;
  /** This group's own slot inside that result. NOT the array position. */
  groupId: string;
  options: string[];
  questionnaireAttribute: string | null;
  /** The user skipped this group: render the one-line state with Undo. */
  dismissed?: boolean;
  /** From an earlier conversation: render inert, never commit. */
  stale?: boolean;
  /** The existing fact this reading REPLACES, or null to add. */
  replacesFactId?: string | null;
  /** The topic guideline this fact's topics generate under. Without it the
   *  fact falls to the shipped one-size topic prompt. */
  topicSkillId?: string | null;
}

export const FactChoiceCard: React.FC<FactChoiceCardProps> = ({
  resultKey,
  baseResult,
  groupIndex,
  groupId,
  options,
  questionnaireAttribute,
  dismissed = false,
  stale = false,
  replacesFactId = null,
  topicSkillId = null,
}) => {
  const { t } = useTranslation();
  // Index 0 is Mera's preferred reading, preselected — so the unambiguous case
  // (one option) really is one tap.
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<View>(null);

  /**
   * What a replacement would destroy.
   *
   * `null` while it is being read, and it STAYS null if the read fails. Accept
   * is gated on it, so a card can never offer an irreversible destroy before
   * it can name the target: a fast tapper would otherwise wipe a fact and its
   * topics without ever seeing which.
   */
  const [replaces, setReplaces] = useState<
    { statement: string; topicCount: number; attribute: string | null } | null
  >(null);
  const [replacesFailed, setReplacesFailed] = useState(false);

  useEffect(() => {
    if (!replacesFactId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [facts, topics] = await Promise.all([
          getFacts(),
          getByFact(replacesFactId),
        ]);
        const target = facts.find((f) => f.id === replacesFactId);
        if (cancelled) return;
        if (!target) {
          // The fact is already gone, so nothing would be destroyed and
          // `commitFactChoices` degrades this to a plain add. Offering it as a
          // replacement would name a fact that no longer exists.
          setReplacesFailed(true);
          return;
        }
        setReplaces({
          statement: target.statement,
          topicCount: topics.filter((t) => t.status === 'active').length,
          attribute: target.questionnaireAttribute ?? null,
        });
      } catch {
        if (!cancelled) setReplacesFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [replacesFactId]);

  // The rule the whole disclosure turns on: no accept until the card can say
  // what disappears. A failed read keeps it disabled rather than falling back
  // to a plain Add, which would write a duplicate AND leave the old fact
  // standing — a silent wrong outcome instead of a visible blocked one.
  /**
   * A HOME FACT IS ONLY REPLACED BY A HOME FACT, on every engine. The cloud
   * loop already demotes such a replace; the on-device path has no loop, so
   * the card is the one place both paths pass through. Once the target is
   * read and the rule refuses, the card is an ordinary add.
   */
  const replaceRefused =
    replaces !== null && !mayReplaceKey(questionnaireAttribute, replaces.attribute);
  const isReplace = replacesFactId !== null && !replaceRefused;
  const acceptBlocked = isReplace && replaces === null;

  /**
   * KEEP BOTH (owner ask N17): offered only when both facts can be true at
   * once, i.e. they sit under DIFFERENT attribute keys (where someone is from
   * next to where they live). Two facts under the same key contradict each
   * other (two current homes), so they do not get the option. A retired
   * combined origin-and-home fact DOES: it still carries the home, and on
   * device the reply said "I can keep both" above a card that could not
   * (ux1 C4). Decided from the
   * target the card has already read, so it is never offered before the card
   * can name what it would keep.
   */
  const canKeepBoth =
    isReplace
    && replaces !== null
    // Both keys KNOWN and different. An unknown key says nothing about
    // whether the two facts can both be true.
    && attributeKey(replaces.attribute) !== ''
    && attributeKey(questionnaireAttribute) !== ''
    && !contradicts(replaces.attribute, questionnaireAttribute);

  /**
   * KEEP BOTH IS ALWAYS OFFERED on a replace card (owner ruling ux2: "there
   * should always be an option to keep both"): it adds the chosen reading and
   * leaves the old fact and its topics untouched. `canKeepBoth` above now only
   * picks the wording and the disclosure: a non-contradicting pair gets the
   * neutral "Also add this?", a contradiction keeps "Replace this fact?" and
   * its red block. Offered once the card can name the fact it would keep.
   */
  const keepBothOffered = isReplace && replaces !== null;

  // `dismissed` and the derived pending/saved split come from the DERIVER, which
  // reads this group's own slot. This component deliberately no longer decides
  // "am I answered" from the presence of a value at `resultKey`: that check was
  // shared by every sibling card, so the first tap settled all of them.
  const single = options.length === 1;

  // Replacing a card in place moves content under the reader's finger, so the
  // new state has to be announced rather than silently swapped. Focus lands on
  // the card that changed, not on the list.
  const announce = () => {
    const node = findNodeHandle(cardRef.current);
    if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
  };

  const handleAdd = (mode: 'replace-or-add' | 'keep-both' = 'replace-or-add') => async () => {
    if (busy || stale || dismissed || acceptBlocked) return;
    if (mode === 'keep-both' && !keepBothOffered) return;
    setBusy(true);
    void hapticLight();
    try {
      const statement = options[selected] ?? options[0];
      const { savedFacts, conflicts } = await commitFactChoices([
        {
          statement,
          // Passed through so `resolveUserLocationFact` keeps recognising a
          // residence fact. Dropping it here would silently strip `userLocation`
          // from every future topic run.
          questionnaire: questionnaireAttribute ? { attribute: questionnaireAttribute } : undefined,
          // ONE transaction in fact-commit, never delete-then-add. Keep both
          // is a plain add: the old fact and its topics stay.
          ...(replacesFactId && isReplace && mode === 'replace-or-add' ? { replaces: replacesFactId } : {}),
          // The route the chat turn already chose, so topic generation runs
          // this fact's own guideline instead of the shipped one-size prompt.
          ...(topicSkillId ? { skillId: topicSkillId } : {}),
        },
      ]);
      // KEEP BOTH ALREADY ANSWERED THE CONFLICT with the fact it keeps (ux2
      // batch 25, D4): a second "Possible conflict" card asked the same thing.
      const shown =
        mode === 'keep-both' && replacesFactId
          ? conflicts.filter((c) => c.existingFactId !== replacesFactId)
          : conflicts;
      // Only THIS group's slot changes. Every sibling keeps its own state.
      resolveGroup(
        resultKey,
        groupId,
        { status: 'saved', statements: [statement], savedFacts, conflicts: shown },
        baseResult,
      );
      void hapticSuccess();
      announce();
    } catch (err) {
      logger.error('[FactChoiceCard] commit failed', err, { resultKey, groupId, groupIndex });
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    if (busy || stale || dismissed) return;
    void hapticLight();
    // Nothing was ever written, so there is nothing to undo in the DATA — this
    // records the choice so the composer unblocks. The card keeps its options so
    // Undo can restore it exactly.
    resolveGroup(
      resultKey,
      groupId,
      { status: 'dismissed', options, questionnaireAttribute },
      baseResult,
    );
    announce();
  };

  const handleUndo = () => {
    if (busy || stale) return;
    void hapticLight();
    // Removing the entry returns the group to pending, which re-blocks the
    // composer — correct: an unanswered question is unanswered again.
    resolveGroup(resultKey, groupId, undefined, baseResult);
    announce();
  };

  if (dismissed) {
    return (
      <Animated.View
        ref={cardRef}
        entering={cardEntering}
        style={[styles.card, styles.cardSettled]}
        accessible
        accessibilityLiveRegion="polite"
        testID={`fact-choice-dismissed-${groupIndex}`}
      >
        <View style={styles.headerRow}>
          <MaterialIcons name="close" size={18} color={ACCENT} />
          <Text size="sm" bold style={styles.title}>
            {t('factChoice.dismissedTitle')}
          </Text>
          {!stale && (
            <Pressable
              onPress={handleUndo}
              hitSlop={12}
              style={styles.undoButton}
              accessibilityRole="button"
              accessibilityLabel={t('topicPlan.undo')}
              testID={`fact-choice-undo-${groupIndex}`}
            >
              <Text size="xs" bold style={styles.undoText}>
                {t('topicPlan.undo')}
              </Text>
            </Pressable>
          )}
        </View>
        <Text size="xs" style={styles.settledSub}>
          {t('factChoice.dismissedSummary')}
        </Text>
      </Animated.View>
    );
  }

  return (
    // NO `entering` on the pending card. The cards used to fade in inside the
    // inverted list while the bulk row below them was already drawn, so
    // "Skip all / Add all (2)" sat over an empty band (audit F7). A pending
    // card now lands in the same frame as its bulk row.
    <Animated.View style={[styles.card, stale && styles.cardSettled]}>
      <View style={styles.headerRow}>
        <MaterialIcons
          name={isReplace ? 'swap-horiz' : 'help-outline'}
          size={18}
          color={ACCENT}
        />
        <Text size="sm" bold style={styles.title}>
          {isReplace
            ? canKeepBoth
              ? t('factChoice.titleAlsoAdd')
              : t('factChoice.titleReplace')
            : single
              ? t('factChoice.titleSingle')
              : t('factChoice.titleChoose')}
        </Text>
      </View>

      <View style={styles.rows}>
        {options.map((option, idx) => {
          const isSel = idx === selected;
          const interactive = !single && !stale && !busy;
          return (
            <Pressable
              key={`${resultKey}-${groupIndex}-${idx}`}
              onPress={interactive ? () => setSelected(idx) : undefined}
              disabled={!interactive}
              accessibilityRole={single ? 'text' : 'radio'}
              accessibilityState={{ selected: isSel }}
              // The reading itself, never the radio glyph before it.
              accessibilityLabel={option}
              testID={`fact-choice-option-${groupIndex}-${idx}`}
              style={[styles.optionRow, isSel && !single && styles.optionRowSelected]}
            >
              {!single && (
                <MaterialIcons
                  name={isSel ? 'radio-button-checked' : 'radio-button-unchecked'}
                  size={18}
                  color={isSel ? ACCENT : 'rgb(150, 150, 150)'}
                />
              )}
              {/* Statements are English by the agent's LANGUAGE rule and are what
                  reaches addFact. Only the RENDERING is translated — the commit
                  reads `options[selected]`, never what is drawn here. */}
              <TranslatableDynamic text={option} size="sm" style={styles.optionText} numberOfLines={3} />
            </Pressable>
          );
        })}
      </View>

      {/* THE DISCLOSURE. It names the fact and the topic count before the tap,
          and says plainly that there is no undo — a replacement destroys the
          old fact and every topic it owns in one transaction with no inverse.
          The statement is its own node rather than an interpolation because it
          goes through TranslatableDynamic, which returns a component. */}
      {/* KEEP BOTH: the old fact is not going anywhere unless Replace is
          tapped, so it is shown as an overlap in neutral text, with one plain
          line on what Replace would do. The red, no-undo block is only for a
          card whose only accept IS the destroy (ux1 C4). */}
      {canKeepBoth && !stale && replaces && (
        <View style={styles.replaceBox} testID={`fact-choice-overlaps-${groupIndex}`}>
          <View style={styles.replaceHeader}>
            <MaterialIcons name="compare-arrows" size={16} color={NEUTRAL_LABEL} />
            <Text size="xs" bold style={styles.overlapLabel}>
              {t('factChoice.overlapsLabel')}
            </Text>
          </View>
          <TranslatableDynamic
            text={replaces.statement}
            size="xs"
            style={styles.replaceStatement}
            numberOfLines={2}
          />
          <Text size="xs" style={styles.replaceDetail} numberOfLines={2}>
            {t('factChoice.overlapsReplaceNote')}
          </Text>
        </View>
      )}

      {isReplace && !canKeepBoth && !stale && (
        <View style={styles.replaceBox} testID={`fact-choice-replaces-${groupIndex}`}>
          <View style={styles.replaceHeader}>
            <MaterialIcons name="warning-amber" size={16} color={DESTRUCTIVE} />
            <Text size="xs" bold style={styles.replaceLabel}>
              {replaces ? t('factChoice.replacesLabel') : null}
            </Text>
          </View>

          {replaces ? (
            <>
              <TranslatableDynamic
                text={replaces.statement}
                size="xs"
                style={styles.replaceStatement}
                numberOfLines={2}
              />
              <Text size="xs" style={styles.replaceDetail} numberOfLines={2}>
                {t('factChoice.replacesTopics', { count: replaces.topicCount })}
              </Text>
              <Text size="xs" style={styles.replaceWarning} numberOfLines={3}>
                {t('factChoice.replacesNoUndo')}
              </Text>
            </>
          ) : (
            <Text size="xs" style={styles.replaceDetail} numberOfLines={3}>
              {replacesFailed
                ? t('factChoice.replacesUnavailable')
                : t('factChoice.replacesLoading')}
            </Text>
          )}
        </View>
      )}

      {stale ? (
        <Text size="xs" style={styles.settledSub}>
          {t('factChoice.expired')}
        </Text>
      ) : isReplace ? (
        // STACKED, so German-length labels never squeeze. Owner order (ux2):
        // Replace (outlined, destructive tint), Keep both (the one filled,
        // safe choice), Skip as plain text.
        <View style={styles.buttonStack}>
          <Button
            testID={`fact-choice-add-${groupIndex}`}
            onPress={handleAdd('replace-or-add')}
            isDisabled={busy || acceptBlocked}
            className="rounded-full bg-transparent border border-error-400"
            size="sm"
          >
            <ButtonText className="text-sm" style={styles.replaceButtonText}>
              {t('factChoice.replace')}
            </ButtonText>
          </Button>
          {keepBothOffered && (
            <Button
              testID={`fact-choice-keep-both-${groupIndex}`}
              onPress={handleAdd('keep-both')}
              isDisabled={busy}
              className="rounded-full bg-primary-400"
              size="sm"
            >
              <ButtonText className="text-white text-sm">{t('factChoice.keepBoth')}</ButtonText>
            </Button>
          )}
          <Pressable
            testID={`fact-choice-dismiss-${groupIndex}`}
            onPress={handleDismiss}
            disabled={busy}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            style={styles.skipText}
          >
            <Text size="sm" style={styles.skipLabel}>
              {t('factChoice.dismiss')}
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.buttonRow}>
          <Button
            testID={`fact-choice-dismiss-${groupIndex}`}
            onPress={handleDismiss}
            isDisabled={busy}
            className="flex-1 rounded-full bg-background-100"
            size="sm"
          >
            <ButtonText className="text-typography-700 text-sm">{t('factChoice.dismiss')}</ButtonText>
          </Button>
          <Button
            testID={`fact-choice-add-${groupIndex}`}
            onPress={handleAdd('replace-or-add')}
            isDisabled={busy || acceptBlocked}
            className="flex-1 rounded-full bg-primary-400"
            size="sm"
          >
            <ButtonText className="text-white text-sm">{t('factChoice.add')}</ButtonText>
          </Button>
        </View>
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
  // Opacity alone would drag the body text under 4.5:1 on the dark ground, so a
  // settled card dims its CHROME and the text below keeps its own contrast.
  cardSettled: { gap: 6, borderColor: 'rgba(231, 138, 83, 0.45)' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: ACCENT, flex: 1 },
  // 'rgb(170,170,170)' on this card's ground measures ~4.1:1 — under the 4.5:1
  // floor for body text. This is the settled state's only prose, so it is the
  // one place that mattered.
  settledSub: { color: 'rgb(200, 200, 200)' },
  undoButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: ACCENT,
  },
  undoText: { color: ACCENT },
  replaceBox: {
    gap: 3,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255, 255, 255, 0.15)',
  },
  replaceHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  replaceLabel: { color: DESTRUCTIVE },
  overlapLabel: { color: NEUTRAL_LABEL },
  replaceStatement: { color: 'rgb(210, 210, 210)', marginLeft: 22 },
  replaceDetail: { color: 'rgb(190, 190, 190)', marginLeft: 22 },
  replaceWarning: { color: DESTRUCTIVE, marginLeft: 22, marginTop: 2 },
  rows: { gap: 6 },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  optionRowSelected: {
    borderColor: ACCENT,
    backgroundColor: 'rgba(231, 138, 83, 0.10)',
  },
  optionText: { flex: 1, color: 'rgb(210, 210, 210)' },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 2 },
  buttonStack: { gap: 8, marginTop: 2 },
  replaceButtonText: { color: DESTRUCTIVE },
  skipText: { alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 16, minHeight: 44, justifyContent: 'center' },
  skipLabel: { color: 'rgb(200, 200, 200)' },
});

export default FactChoiceCard;
