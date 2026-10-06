// Arrange a tab's pages in place: the pen turns the strip into an overlay
// over the dimmed page. Each page is a glass pill with a grip and a slow
// glowing outline; press and hold to lift it (light haptic), drag, let go.
// ✕ cancels, ✓ saves. World adds an × per country and an add field.
//
// DRAFT-ONLY: nothing is written before ✓ (arrange-model.ts). ✕ and Android
// Back discard every reorder, removal and addition.
//
// Accessibility: the overlay is modal to VoiceOver; each pill is one element
// with "Move earlier" / "Move later" (and "Remove" in World) actions; the ×
// is also its own button for touch. ✓ announces "Order saved".
//
// The glow is the pill's own rounded border changing COLOUR only (constant
// width, no extra outline view), so nothing reflows while it breathes; under
// Reduce Motion and Lite mode it holds a static orange border. Not a Modal: the overlay belongs to this tab and must
// leave the tab bar where it is.

import { GlassPanel } from '@/components/custom/GlassSurface';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { hapticLight } from '@/lib/haptics';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AccessibilityInfo,
  BackHandler,
  I18nManager,
  StyleSheet,
  TextInput,
  View,
  type AccessibilityActionEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  interpolateColor,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  addCountry,
  dropIndexFor,
  filterAddable,
  initialArrange,
  removePage,
  reorder,
  slotToIndex,
  toDraft,
  type ArrangeState,
  type PillRect,
} from './arrange-model';
import { setArrangeOpen } from './current-surface';
import { alpha2OfPage, type PageId } from './page-registry';
import { NAV_ACCENT } from './QuickSettingsButton';
import { flagEmoji } from './PageStrip';
import type { ArrangeConfig, PagePill } from './types';

const GLOW_PERIOD_MS = 1600;
/** Constant: the glow animates colour only, never width. */
export const PILL_BORDER_WIDTH = 1.5;
const GLASS_BORDER = 'rgba(255,255,255,0.14)';
const LIFTED_BORDER = 'rgba(255,255,255,0.32)';
const LIFT_DELAY_MS = 220;
const MAX_RESULTS = 6;
const GLYPH_HIDDEN = {
  accessible: false,
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;

export interface ArrangeOverlayProps {
  readonly tabLabel: string;
  readonly pages: readonly PagePill[];
  readonly arrange: ArrangeConfig;
  readonly onClose: () => void;
}

interface ChipProps {
  readonly id: PageId;
  readonly label: string;
  readonly flag: string;
  readonly index: number;
  readonly count: number;
  readonly removable: boolean;
  readonly glow: SharedValue<number>;
  readonly onLayout: (id: PageId, rect: PillRect) => void;
  readonly onDrop: (from: number, dx: number, dy: number) => void;
  readonly onMove: (from: number, to: number) => void;
  readonly onRemove: (id: PageId) => void;
}

const ArrangeChip: React.FC<ChipProps> = ({
  id,
  label,
  flag,
  index,
  count,
  removable,
  glow,
  onLayout,
  onDrop,
  onMove,
  onRemove,
}) => {
  const { t } = useTranslation();
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const lifted = useSharedValue(0);

  const lift = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(LIFT_DELAY_MS)
        .onStart(() => {
          lifted.value = 1;
          runOnJS(hapticLight)();
        })
        .onUpdate((e) => {
          tx.value = e.translationX;
          ty.value = e.translationY;
        })
        .onEnd((e) => {
          runOnJS(onDrop)(index, e.translationX, e.translationY);
        })
        .onFinalize(() => {
          lifted.value = 0;
          tx.value = 0;
          ty.value = 0;
        }),
    [index, onDrop, lifted, tx, ty],
  );

  // The lift (drag only) moves and scales the whole chip. At rest nothing
  // that affects layout animates.
  const frameStyle = useAnimatedStyle(() => ({
    zIndex: lifted.value ? 10 : 0,
    transform: [
      { translateX: tx.value },
      { translateY: ty.value - 3 * lifted.value },
      { scale: 1 + 0.06 * lifted.value },
    ],
  }));
  // The glow is the pill's OWN rounded border, colour only: a constant
  // width, so the row never reflows while it breathes.
  const ringStyle = useAnimatedStyle(() => ({
    borderColor: lifted.value
      ? LIFTED_BORDER
      : interpolateColor(glow.value, [0, 1], [GLASS_BORDER, NAV_ACCENT]),
  }));

  const actions = [
    ...(index > 0 ? [{ name: 'earlier', label: t('nav.arrange.moveEarlier') }] : []),
    ...(index < count - 1 ? [{ name: 'later', label: t('nav.arrange.moveLater') }] : []),
    ...(removable ? [{ name: 'remove', label: t('nav.arrange.removeA11y', { name: label }) }] : []),
  ];
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'earlier') onMove(index, index - 1);
    else if (e.nativeEvent.actionName === 'later') onMove(index, index + 1);
    else if (e.nativeEvent.actionName === 'remove') onRemove(id);
  };

  return (
    <Animated.View
      style={frameStyle}
      onLayout={(e) => onLayout(id, e.nativeEvent.layout)}
      testID={`arrange-chip-${id}-frame`}
    >
      <GestureDetector gesture={lift}>
        <View
          style={styles.chipFrame}
          accessible
          accessibilityLabel={t('nav.pillA11y', { label, index: index + 1, count })}
          accessibilityActions={actions}
          onAccessibilityAction={onAction}
          testID={`arrange-chip-${id}`}
        >
          <GlassPanel radius={999}>
            <Animated.View style={[styles.chip, ringStyle]} testID={`arrange-chip-${id}-pill`}>
              <MaterialIcons name="drag-indicator" size={16} color="rgba(255,255,255,0.6)" {...GLYPH_HIDDEN} />
              {flag ? <Text style={styles.flag}>{flag}</Text> : null}
              <Text size="sm" scaleTier="chrome" numberOfLines={1} className="text-white">
                {label}
              </Text>
              {removable ? <View style={styles.xSpacer} /> : null}
            </Animated.View>
          </GlassPanel>
        </View>
      </GestureDetector>
      {removable ? (
        // A 44pt frame drawn over the chip's end; its own button for touch.
        <View style={styles.xFrame} testID={`arrange-remove-${id}-frame`}>
          <View style={styles.xCircle} pointerEvents="none" {...GLYPH_HIDDEN}>
            <MaterialIcons name="close" size={14} color="#FFFFFF" />
          </View>
          <Pressable
            onPress={() => onRemove(id)}
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel={t('nav.arrange.removeA11y', { name: label })}
            testID={`arrange-remove-${id}`}
          />
        </View>
      ) : null}
    </Animated.View>
  );
};

const ArrangeOverlay: React.FC<ArrangeOverlayProps> = ({ tabLabel, pages, arrange, onClose }) => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const rtl = I18nManager.isRTL;
  const reduceMotion = useReducedMotion();
  const liteMode = useDisplayPrefsStore((s) => s.liteMode);
  const still = reduceMotion || liteMode;

  const [state, setState] = useState<ArrangeState>(() => initialArrange(pages.map((p) => p.id)));
  const [query, setQuery] = useState('');
  const [lastRemoved, setLastRemoved] = useState<PageId | null>(null);
  const rects = useRef<Partial<Record<string, PillRect>>>({});

  // Labels for pages in the draft, existing or added in it.
  const labelOf = useMemo(() => {
    const m = new Map<string, { label: string; flag: string }>();
    for (const p of pages) m.set(p.id, { label: p.label, flag: p.flagAlpha2 ? flagEmoji(p.flagAlpha2) : '' });
    for (const c of state.added) m.set(`country:${c.alpha2.toUpperCase()}`, { label: c.name, flag: flagEmoji(c.alpha2) });
    return m;
  }, [pages, state.added]);

  useEffect(() => {
    setArrangeOpen(true);
    arrange.onOpen?.();
    return () => setArrangeOpen(false);
    // Open once per overlay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  // One clock for every chip's glow; under Reduce Motion or Lite mode it
  // holds still at the full accent (a static orange border).
  const glow = useSharedValue(1);
  useEffect(() => {
    if (still) {
      cancelAnimation(glow);
      glow.value = 1;
      return;
    }
    glow.value = 0;
    glow.value = withRepeat(withTiming(1, { duration: GLOW_PERIOD_MS / 2 }), -1, true);
    return () => cancelAnimation(glow);
  }, [still, glow]);

  const onChipLayout = useCallback((id: PageId, rect: PillRect) => {
    rects.current[id] = rect;
  }, []);

  const onMove = useCallback((from: number, to: number) => {
    setState((s) => (to < 0 || to >= s.order.length ? s : reorder(s, from, to)));
  }, []);

  const onDrop = useCallback(
    (from: number, dx: number, dy: number) => {
      setState((s) => {
        const r = rects.current[s.order[from]];
        if (!r) return s;
        const slot = dropIndexFor(
          s.order.map((id) => rects.current[id]),
          r.x + r.width / 2 + dx,
          r.y + r.height / 2 + dy,
          rtl,
        );
        return reorder(s, from, slotToIndex(from, slot));
      });
    },
    [rtl],
  );

  const onRemove = useCallback((id: PageId) => {
    setState((s) => removePage(s, id));
    setLastRemoved(id);
  }, []);

  const save = useCallback(async () => {
    await arrange.onSave(toDraft(state));
    AccessibilityInfo.announceForAccessibility(t('nav.arrange.saved'));
    onClose();
  }, [arrange, state, onClose, t]);

  const world = arrange.world;
  const results = world && query.trim() ? filterAddable(world.search(query.trim()), state).slice(0, MAX_RESULTS) : [];
  const footnoteId =
    lastRemoved ?? (world ? (state.order.find((id) => world.footnoteFor(id) !== null) ?? null) : null);
  const footnote = world && footnoteId ? world.footnoteFor(footnoteId) : null;

  return (
    <View style={[StyleSheet.absoluteFill, styles.layer]} accessibilityViewIsModal testID="arrange-overlay">
      <View style={styles.dim} pointerEvents="auto" {...GLYPH_HIDDEN} testID="arrange-dim" />
      <View style={[styles.panel, { paddingTop: insets.top + 8 }]}>
        <View style={styles.chips} testID="arrange-chips">
          {state.order.map((id, i) => {
            const meta = labelOf.get(id) ?? { label: id, flag: '' };
            return (
              <ArrangeChip
                key={id}
                id={id}
                label={meta.label}
                flag={meta.flag || (alpha2OfPage(id) ? flagEmoji(alpha2OfPage(id)!) : '')}
                index={i}
                count={state.order.length}
                removable={!!world && world.removable(id)}
                glow={glow}
                onLayout={onChipLayout}
                onDrop={onDrop}
                onMove={onMove}
                onRemove={onRemove}
              />
            );
          })}
        </View>

        {world ? (
          <View style={styles.field} testID="arrange-add-field">
            <MaterialIcons name="search" size={18} color="rgba(255,255,255,0.6)" {...GLYPH_HIDDEN} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t('nav.arrange.addPlaceholder')}
              placeholderTextColor="rgba(255,255,255,0.5)"
              aria-label={t('nav.arrange.addPlaceholder')}
              autoCorrect={false}
              autoCapitalize="words"
              style={styles.input}
              testID="arrange-add-input"
            />
          </View>
        ) : null}

        <View style={styles.actions}>
          <View style={styles.roundFrame}>
            <View style={[styles.round, styles.roundCancel]} pointerEvents="none" {...GLYPH_HIDDEN}>
              <MaterialIcons name="close" size={20} color="#FFFFFF" />
            </View>
            <Pressable
              onPress={onClose}
              style={StyleSheet.absoluteFill}
              accessibilityRole="button"
              accessibilityLabel={t('common.cancel')}
              testID="arrange-cancel"
            />
          </View>
          <View style={styles.roundFrame}>
            <View style={[styles.round, styles.roundSave]} pointerEvents="none" {...GLYPH_HIDDEN}>
              <MaterialIcons name="check" size={20} color="#121113" />
            </View>
            <Pressable
              onPress={() => void save()}
              style={StyleSheet.absoluteFill}
              accessibilityRole="button"
              accessibilityLabel={t('common.save')}
              testID="arrange-save"
            />
          </View>
        </View>
      </View>

      {world && query.trim() ? (
        <View style={styles.results} testID="arrange-results">
          {results.length === 0 ? (
            <Text size="sm" className="text-gray-300" style={styles.noMatch} testID="arrange-no-match">
              {t('nav.arrange.noMatch', { query: query.trim() })}
            </Text>
          ) : (
            results.map((c) => (
              <View key={c.alpha2} style={styles.resultRow}>
                <View style={styles.resultVisual} pointerEvents="none" {...GLYPH_HIDDEN}>
                  <Text style={styles.flag}>{flagEmoji(c.alpha2)}</Text>
                  <Text size="md" className="text-white" style={{ flex: 1 }} numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Text size="sm" bold style={{ color: NAV_ACCENT }}>
                    {t('nav.arrange.add')}
                  </Text>
                </View>
                <Pressable
                  onPress={() => {
                    setState((s) => addCountry(s, c));
                    setQuery('');
                  }}
                  style={StyleSheet.absoluteFill}
                  accessibilityRole="button"
                  accessibilityLabel={t('nav.arrange.addA11y', { name: c.name })}
                  testID={`arrange-add-${c.alpha2.toUpperCase()}`}
                />
              </View>
            ))
          )}
        </View>
      ) : null}

      <View style={styles.hint} pointerEvents="none">
        <Text size="sm" className="text-gray-300" testID="arrange-hint">
          {footnote ?? t('nav.arrange.hint', { tab: tabLabel })}
        </Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  dim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  // Above the tab header (zIndex 10).
  layer: { zIndex: 20 },
  panel: {
    paddingHorizontal: 14,
    paddingBottom: 14,
    gap: 12,
    backgroundColor: 'rgba(18,17,19,0.94)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chipFrame: { minHeight: 44, justifyContent: 'center', borderRadius: 999 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 38,
    paddingLeft: 8,
    paddingRight: 12,
    borderRadius: 999,
    borderWidth: PILL_BORDER_WIDTH,
  },
  flag: { fontSize: 13, lineHeight: 16 },
  xSpacer: { width: 18 },
  xFrame: { position: 'absolute', right: -8, top: 0, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  xCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(231,138,83,0.8)',
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  input: { flex: 1, color: '#FFFFFF', fontSize: 15, height: 40 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  roundFrame: { width: 44, height: 44 },
  round: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  roundCancel: { backgroundColor: 'rgba(40,39,42,0.82)', borderColor: 'rgba(255,255,255,0.14)' },
  roundSave: { backgroundColor: NAV_ACCENT, borderColor: NAV_ACCENT },
  results: {
    marginHorizontal: 14,
    marginTop: 4,
    borderRadius: 16,
    backgroundColor: 'rgba(18,17,19,0.97)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  resultRow: { minHeight: 48, justifyContent: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.08)' },
  resultVisual: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 },
  noMatch: { padding: 14 },
  hint: {
    marginHorizontal: 14,
    marginTop: 12,
    padding: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(18,17,19,0.94)',
    borderWidth: 1,
    borderColor: 'rgba(231,138,83,0.5)',
  },
});

export default ArrangeOverlay;
