// TrackStoryCard: the follow-a-story card. Tick the stories to follow, then Follow.
// Status comes only from the card's saved state (outcomes, dismissed, superseded), so a
// resumed card is pending and tappable unless that state says otherwise. Every write goes
// through track-card-actions; this file only draws and wires.

import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Text } from '@/components/ui/text';
import { canRequestMoreOptions } from '@/lib/chat-session/chat-session';
import { hapticSuccess } from '@/lib/haptics';
import type { StagedProposal } from '@/lib/llm/types';
import { useMotionAllowed } from '@/lib/motion-gate';
import { useFloatingChatIsGenerating, useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { themedStyles, tint, useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  findNodeHandle,
  LayoutAnimation,
  PixelRatio,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { GlyphSafeButton } from './glyph-safe';
import { dismissTrackCard, followTickedOptions, loadMoreTrackOptions } from './track-card-actions';
import { MAX_TRACK_CARD_OPTIONS, normaliseTrackText, trackCardStatus, type TrackOutcome } from './track-options';
import type { TrackCardSource } from './types';

// A touch frame is a NUMBER: a NativeWind class like h-11 renders ~38pt here.
const FRAME = 44;
const STACK_FONT_SCALE = 1.3;
/** shortcut: a fixed wait for VoiceOver to read the focused row; tune from the device capture. */
const ANNOUNCE_AFTER_FOCUS_MS = 700;
/** The settle: unticked rows fade out, the card closes up, the check discs fade in. */
const SETTLE_ANIMATION = {
  duration: 240,
  create: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity },
  update: { type: LayoutAnimation.Types.easeOut },
  delete: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity },
};

interface Props {
  proposal: StagedProposal;
  source: TrackCardSource;
  /** Called once new options are on screen, so the thread can scroll the card into view. */
  onGrown?: () => void;
}

const isDone = (o: TrackOutcome | undefined) => o === 'following' || o === 'already';

const TrackStoryCard: React.FC<Props> = ({ proposal, source, onGrown }) => {
  const styles = useStyles();
  const colors = useColors();
  const { t } = useTranslation();
  const isGenerating = useFloatingChatIsGenerating();
  const motion = useMotionAllowed();
  const storedTicks = useFloatingChatStore((s) => s.trackTicks[proposal.id]);
  const moreState = useFloatingChatStore((s) => s.trackMore[proposal.id]);
  const [busy, setBusy] = useState(false);
  const [wrapped, setWrapped] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState<Record<string, string>>({});
  const [shownFailed, setShownFailed] = useState<Record<string, boolean>>({});
  const [pendingGrow, setPendingGrow] = useState<{ firstKey: string; added: number } | null>(null);
  const rowRefs = useRef<Record<string, unknown>>({});

  const { outcomes } = source;
  const status = trackCardStatus({ outcomes, dismissed: source.dismissed, superseded: source.superseded });
  const rows = proposal.actions.flatMap((a) =>
    a.type === 'track_story' ? [{ label: a.label, key: normaliseTrackText(a.label) }] : [],
  );

  const failedKeys = rows.filter((r) => outcomes[r.key] === 'failed').map((r) => r.key);
  const hasOutcomes = Object.keys(outcomes).length > 0;
  const defaultTicks = hasOutcomes ? failedKeys : rows.slice(0, 1).map((r) => r.key);
  const ticks = storedTicks ?? defaultTicks;

  // The first row written flips the status to followed while the rest are still being
  // followed, so the card keeps its asking look until the whole batch is done.
  const settled = status === 'followed' && !busy;
  const pending = status === 'pending' || (status === 'followed' && busy);
  // A row is a checkbox only while the card is pending and the row is not already followed.
  const isBox = (key: string) => pending && !isDone(outcomes[key]);
  const ticked = rows.filter((r) => isBox(r.key) && ticks.includes(r.key));
  const anyFailed = rows.some((r) => outcomes[r.key] === 'failed');

  const doneCount = rows.filter((r) => isDone(outcomes[r.key])).length;
  const failedCount = failedKeys.length;

  const toggle = (key: string) => {
    if (busy) return;
    useFloatingChatStore.getState().setTrackTicks(proposal.id, ticks.includes(key) ? ticks.filter((k) => k !== key) : [...ticks, key]);
  };

  const follow = async () => {
    if (busy || ticked.length === 0) return;
    const labels = ticked.map((r) => r.label);
    setBusy(true);
    let result: Awaited<ReturnType<typeof followTickedOptions>> | null = null;
    try {
      result = await followTickedOptions(source, proposal, labels);
    } finally {
      if (motion) LayoutAnimation.configureNext(SETTLE_ANIMATION);
      setBusy(false);
    }
    const done = ticked.filter((r) => isDone(result?.outcomes[r.key])).length;
    const line =
      done === labels.length
        ? t('trackedStories.followingAll', { count: done })
        : done > 0
          ? t('trackedStories.followingSome', { done, count: labels.length })
          : t('trackedStories.followFailedAll');
    AccessibilityInfo.announceForAccessibility(line);
    if (done > 0) void hapticSuccess();
  };

  const more = async () => {
    AccessibilityInfo.announceForAccessibility(t('trackedStories.moreOptionsLoading'));
    const before = rows.length;
    const res = await loadMoreTrackOptions(source, proposal);
    // The grown proposal arrives with the next render: focus the first new row there.
    if (res.added > 0) setPendingGrow({ firstKey: `#${before}`, added: res.added });
  };

  // Once the grown rows are drawn: focus the first new row, then say so, then scroll.
  useEffect(() => {
    if (!pendingGrow) return;
    const index = Number(pendingGrow.firstKey.slice(1));
    const row = rows[index];
    const node = row ? rowRefs.current[row.key] : null;
    if (!node) return;
    setPendingGrow(null);
    const tag = findNodeHandle(node as never);
    if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
    onGrown?.();
    // After the focus change has spoken the row: an announcement sent with it is cut off.
    const added = t('trackedStories.moreOptionsAdded', { count: pendingGrow.added });
    setTimeout(() => AccessibilityInfo.announceForAccessibility(added), ANNOUNCE_AFTER_FOCUS_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGrow, rows.length]);

  if (status === 'dismissed') {
    return (
      <View style={styles.card} testID="track-card-dismissed">
        <View style={styles.headerRow}>
          <MaterialIcons {...DECORATIVE_ICON_A11Y} name="cancel" size={16} color={colors.ink3} />
          <Text size="sm" style={styles.mutedText}>
            {t('articleFeedback.proposalCancel')}
          </Text>
        </View>
      </View>
    );
  }

  const outcomeText = (o: TrackOutcome | undefined) =>
    o === 'following'
      ? t('trackedStories.rowFollowing')
      : o === 'already'
        ? t('trackedStories.rowAlready')
        : o === 'failed'
          ? t('trackedStories.rowFailed')
          : null;

  const noteShown = (key: string) => (st: { displayedText: string; translationFailed: boolean }) => {
    setShown((p) => (p[key] === st.displayedText ? p : { ...p, [key]: st.displayedText }));
    setShownFailed((p) => (p[key] === st.translationFailed ? p : { ...p, [key]: st.translationFailed }));
  };
  const labelText = (r: { label: string; key: string }) =>
    shown[r.key] ?? r.label;
  const spoken = (r: { label: string; key: string }) =>
    shownFailed[r.key] ? `${labelText(r)}. ${t('feed.translationFailed')}` : labelText(r);

  const labelNode = (r: { label: string; key: string }, muted: boolean) => (
    <TranslatableDynamic
      text={r.label}
      size="sm"
      style={muted ? styles.rowTextMuted : styles.rowText}
      failedGlyph="decorative"
      onDisplayChange={noteShown(r.key)}
    />
  );

  if (settled) {
    // Settled: the card stops asking. Only the rows that were followed (or failed) stay.
    const openFollowed = () => {
      useFloatingChatStore.getState().collapse();
      (require('@/components/custom/nav/navigate-to-page') as typeof import('@/components/custom/nav/navigate-to-page')).navigateToPage('stories');
    };
    return (
      <View style={[styles.card, styles.cardSettled]} testID="track-card-followed">
        <View style={styles.headerRow}>
          <MaterialIcons {...DECORATIVE_ICON_A11Y} name="check-circle" size={18} color={colors.accentMark} />
          <Text size="sm" bold style={styles.settledTitle}>
            {failedCount > 0
              ? t('trackedStories.followingSome', { done: doneCount, count: doneCount + failedCount })
              : t('trackedStories.followingAll', { count: doneCount })}
          </Text>
        </View>
        <View testID="proposal-actions" style={styles.rows}>
          {rows.map((r, idx) => {
            const outcome = outcomes[r.key];
            if (!outcome) return null;
            const done = isDone(outcome);
            // The disc sits beside, never inside, the accessible row: an icon glyph under
            // an accessible element is read aloud on iOS.
            return (
              <View key={r.key} style={styles.settledRow}>
                {done ? (
                  <View style={styles.disc}>
                    <MaterialIcons {...DECORATIVE_ICON_A11Y} name="check" size={14} color={colors.onAccent} />
                  </View>
                ) : (
                  <MaterialIcons {...DECORATIVE_ICON_A11Y} name="error-outline" size={20} color={colors.ink3} />
                )}
                <View
                  testID={`track-row-${idx}`}
                  accessible
                  accessibilityRole="text"
                  accessibilityLabel={`${spoken(r)}, ${outcomeText(outcome)}`}
                  style={styles.rowBody}
                >
                  {labelNode(r, false)}
                  {outcome !== 'following' && (
                    <Text size="xs" style={outcome === 'failed' ? styles.failedText : styles.outcomeText}>
                      {outcomeText(outcome)}
                    </Text>
                  )}
                </View>
              </View>
            );
          })}
        </View>
        <View style={styles.divider} />
        <GlyphSafeButton
          testID="track-see-followed"
          onPress={openFollowed}
          accessibilityRole="button"
          accessibilityState={{ disabled: false }}
          accessibilityLabel={t('trackedStories.seeFollowedStories')}
          style={styles.frame}
          visualStyle={styles.linkRow}
        >
          <Text size="sm" style={styles.moreText}>
            {t('trackedStories.seeFollowedStories')}
          </Text>
          <MaterialIcons {...DECORATIVE_ICON_A11Y} name="chevron-right" size={20} color={colors.accentText} />
        </GlyphSafeButton>
      </View>
    );
  }

  const expired = status === 'expired';
  const showMore =
    pending &&
    canRequestMoreOptions() &&
    rows.length < MAX_TRACK_CARD_OPTIONS &&
    !isGenerating &&
    moreState !== 'loading';
  const loadingMore = pending && moreState === 'loading';

  const followLabel = busy
    ? t('trackedStories.followingBusy')
    : ticked.length === 0
      ? t('trackedStories.follow')
      : anyFailed
        ? t('trackedStories.tryAgain')
        : t('trackedStories.followTicked', { count: ticked.length });
  // While saving the button keeps its accent look: rows leave `ticked` as each one lands.
  const followDisabled = ticked.length === 0 && !busy;
  const stacked =
    PixelRatio.getFontScale() >= STACK_FONT_SCALE || wrapped.follow === true || wrapped.cancel === true;
  // LATCHED: once a label wrapped side by side the buttons stay stacked. Unlatched,
  // the stacked label fits on one line, unstacks, wraps again and flips every layout.
  const noteWrap = (which: 'follow' | 'cancel') => (e: { nativeEvent: { lines: unknown[] } }) => {
    if (e.nativeEvent.lines.length > 1) setWrapped((p) => (p[which] ? p : { ...p, [which]: true }));
  };

  const renderRow = (r: { label: string; key: string }, idx: number) => {
    const outcome = outcomes[r.key];
    if (isBox(r.key)) {
      const checked = ticks.includes(r.key);
      const failed = outcome === 'failed';
      return (
        <GlyphSafeButton
          key={r.key}
          testID={`track-option-${idx}`}
          {...({ ref: (n: unknown) => void (rowRefs.current[r.key] = n) } as object)}
          onPress={() => toggle(r.key)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked }}
          accessibilityLabel={failed ? `${spoken(r)}. ${t('trackedStories.rowFailed')}` : spoken(r)}
          style={styles.frame}
          visualStyle={styles.row}
        >
          <MaterialIcons
            {...DECORATIVE_ICON_A11Y}
            name={checked ? 'check-box' : 'check-box-outline-blank'}
            size={18}
            color={checked ? colors.accentMark : colors.ink2}
            style={styles.checkIcon}
          />
          <View style={styles.rowBody}>
            {labelNode(r, false)}
            {failed && (
              <Text size="xs" style={styles.failedText}>
                {t('trackedStories.rowFailed')}
              </Text>
            )}
          </View>
        </GlyphSafeButton>
      );
    }
    // Resolved: one plain text element, label and outcome joined by a comma.
    const text = outcomeText(outcome);
    const muted = !expired && !outcome;
    return (
      <View
        key={r.key}
        testID={`track-row-${idx}`}
        accessible
        accessibilityRole="text"
        accessibilityLabel={text ? `${spoken(r)}, ${text}` : spoken(r)}
        style={styles.row}
      >
        <View style={styles.rowBody}>
          {labelNode(r, muted)}
          {text && (
            <Text size="xs" style={outcome === 'failed' ? styles.failedText : styles.outcomeText}>
              {text}
            </Text>
          )}
        </View>
      </View>
    );
  };

  const footer = (() => {
    if (expired) return { icon: null, text: t('trackedStories.optionsExpired') };
    if (!hasOutcomes) return null;
    if (doneCount === 0) return { icon: 'error-outline' as const, text: t('trackedStories.followFailedAll') };
    if (failedCount > 0)
      return { icon: 'info-outline' as const, text: t('trackedStories.followingSome', { done: doneCount, count: doneCount + failedCount }) };
    return { icon: 'check-circle' as const, text: t('trackedStories.followingAll', { count: doneCount }) };
  })();

  const followButton = (
    <Pressable
      testID="track-follow"
      onPress={follow}
      disabled={followDisabled || busy}
      accessibilityRole="button"
      accessibilityState={{ disabled: followDisabled || busy, busy }}
      style={[styles.button, followDisabled ? styles.buttonDisabled : styles.buttonPrimary, !stacked && styles.buttonFlex]}
    >
      {busy && <ActivityIndicator size="small" color={colors.onAccent} />}
      <Text
        size="sm"
        bold
        style={followDisabled ? styles.disabledLabel : styles.primaryLabel}
        onTextLayout={noteWrap('follow')}
      >
        {followLabel}
      </Text>
    </Pressable>
  );
  const notNowButton = (
    <Pressable
      testID="track-not-now"
      onPress={() => dismissTrackCard(source, proposal.id)}
      accessibilityRole="button"
      accessibilityState={{ disabled: false }}
      style={[styles.button, styles.buttonSecondary, !stacked && styles.buttonFlex]}
    >
      <Text
        size="sm"
        style={styles.secondaryLabel}
        onTextLayout={noteWrap('cancel')}
      >
        {t('articleFeedback.proposalCancel')}
      </Text>
    </Pressable>
  );

  return (
    <View style={[styles.card, expired && styles.cardDimmed]} testID="track-card">
      <View style={styles.headerRow}>
        <MaterialIcons {...DECORATIVE_ICON_A11Y} name="track-changes" size={18} color={colors.accentMark} />
        <Text size="sm" bold style={styles.title}>
          {t('trackedStories.cardTitle')}
        </Text>
      </View>

      <View testID="proposal-actions" style={styles.rows}>
        {rows.map(renderRow)}
      </View>

      {showMore && (
        <GlyphSafeButton
          testID="track-more"
          onPress={more}
          accessibilityRole="button"
          accessibilityState={{ disabled: false }}
          accessibilityLabel={t('trackedStories.moreOptions')}
          style={styles.frame}
          visualStyle={styles.moreRow}
        >
          <MaterialIcons {...DECORATIVE_ICON_A11Y} name="add-circle-outline" size={18} color={colors.accentText} />
          <Text size="sm" style={styles.moreText}>
            {t('trackedStories.moreOptions')}
          </Text>
        </GlyphSafeButton>
      )}
      {loadingMore && (
        <View
          testID="track-more-loading"
          accessible
          accessibilityLabel={t('trackedStories.moreOptionsLoading')}
          accessibilityState={{ busy: true }}
          style={[styles.frame, styles.moreRow]}
        >
          <ActivityIndicator size="small" color={colors.accentMark} />
          <Text size="sm" style={styles.mutedText}>
            {t('trackedStories.moreOptionsLoading')}
          </Text>
        </View>
      )}
      {pending && moreState === 'none' && (
        <Text size="xs" style={styles.mutedText}>
          {t('trackedStories.moreOptionsNone')}
        </Text>
      )}
      {pending && moreState === 'failed' && (
        <Text size="xs" style={styles.mutedText}>
          {t('trackedStories.moreOptionsFailed')}
        </Text>
      )}

      {pending && (
        <View style={stacked ? styles.buttonStack : styles.buttonRow}>
          {followButton}
          {notNowButton}
        </View>
      )}

      {footer && (
        <View style={styles.statusRow}>
          {footer.icon && (
            <MaterialIcons
              {...DECORATIVE_ICON_A11Y}
              name={footer.icon}
              size={16}
              color={footer.icon === 'check-circle' ? colors.accentMark : colors.ink3}
            />
          )}
          <Text size="xs" style={footer.icon ? styles.statusText : styles.expiredText}>
            {footer.text}
          </Text>
        </View>
      )}
    </View>
  );
};

const useStyles = themedStyles((c, mode) =>
  StyleSheet.create({
    card: {
      backgroundColor: tint(c.accent, 0.08),
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.accentMark,
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 10,
    },
    cardDimmed: { opacity: 0.5 },
    // Settled: the accent frame was the ask; a done card wears the neutral content plate.
    cardSettled: { backgroundColor: mode === 'light' ? c.panel : c.surface, borderColor: c.panelBorder },
    settledTitle: { color: c.ink },
    settledRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: FRAME, paddingVertical: 10 },
    disc: {
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: c.accentMark,
      alignItems: 'center',
      justifyContent: 'center',
    },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: c.panelBorder },
    linkRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: FRAME },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { color: c.accentText },
    rows: { gap: 2 },
    frame: { minHeight: FRAME },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      minHeight: FRAME,
      paddingVertical: 10,
    },
    checkIcon: { marginTop: 1 },
    rowBody: { flex: 1, gap: 2 },
    rowText: { color: c.ink },
    rowTextMuted: { color: c.ink3 },
    outcomeText: { color: c.ink2 },
    failedText: { color: c.ink2, fontStyle: 'italic' },
    moreRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: FRAME },
    moreText: { color: c.accentText },
    mutedText: { color: c.ink3 },
    buttonRow: { flexDirection: 'row', gap: 10 },
    buttonStack: { gap: 10 },
    button: {
      minHeight: FRAME,
      borderRadius: 999,
      flexDirection: 'row',
      gap: 8,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    buttonFlex: { flex: 1 },
    buttonPrimary: { backgroundColor: c.accentMark },
    // A disabled button is neutral grey, never a dimmed accent.
    buttonDisabled: { backgroundColor: c.surfaceRaised },
    buttonSecondary: { backgroundColor: c.surfaceRaised },
    primaryLabel: { color: c.onAccent, textAlign: 'center' },
    disabledLabel: { color: c.ink3, textAlign: 'center' },
    secondaryLabel: { color: c.ink, textAlign: 'center' },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    statusText: { color: c.ink2, flexShrink: 1 },
    expiredText: { color: c.ink3, fontStyle: 'italic' },
  }),
);

export default TrackStoryCard;
