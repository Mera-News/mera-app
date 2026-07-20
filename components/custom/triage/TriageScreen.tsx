// NOTE: No entry point by design (product decision 2026-07-20) — the For-You
// triage entry pill was removed in favour of the Feed/Stories/Saved sub-tabs.
// This screen (and its route) are kept intact for future re-exposure; do not
// delete.
//
// TriageScreen — the For-You "triage" one-card review surface.
//
// A single centered card (TriageCard) with the five verdict buttons below
// (TriageActionBar) and an "up next" peek of the next card. Verdicts advance the
// deck via the triage store; when the deck empties we show the shared
// AllCaughtUpCard. Freshly-scored chunks fold in behind the current card live
// (the store's release listener), so the card under review never jumps.
//
// Like the Browse deck it replaces, this suppresses the floating chat bubble on
// focus (the action bar owns feedback here) and fires a soft 600ms-dwell
// impression for the visible card (opens-only seen-state means impressions never
// exclude — this is just a presentation signal).

import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import AllCaughtUpCard from '@/components/custom/AllCaughtUpCard';
import { ArticleSuggestionCompactCard } from '@/components/custom/cards/ArticleSuggestionCompactCard';
import TriageCard from '@/components/custom/triage/TriageCard';
import TriageActionBar from '@/components/custom/triage/TriageActionBar';
import { recordImpression } from '@/lib/database/services/story-impression-service';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import {
  useTriageCurrent,
  useTriageStatus,
  useTriageStore,
} from '@/lib/stores/triage-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ACCENT = '#EDA77E';
/** Soft-signal dwell before a visible card earns an impression. */
const IMPRESSION_DWELL_MS = 600;

function titleNormOf(title: string | null | undefined): string | null {
  return (title ?? '').toLowerCase().trim().replace(/\s+/g, ' ') || null;
}

const noop = () => {};

const TriageScreen: React.FC = () => {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const status = useTriageStatus();
  const { suggestion, next, position, total } = useTriageCurrent();

  const impressionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const impressedIdsRef = useRef<Set<string>>(new Set());

  // --- Lifecycle: build the deck on mount, tear down the release listener. ---
  useEffect(() => {
    void useTriageStore.getState().initDeck();
    return () => {
      if (impressionTimerRef.current) clearTimeout(impressionTimerRef.current);
      useTriageStore.getState().teardown();
    };
  }, []);

  // --- Suppress the floating chat bubble here (the action bar owns feedback). ---
  useFocusEffect(
    useCallback(() => {
      useFloatingChatStore.getState().setSuppressed(true);
      impressedIdsRef.current = new Set();
      return () => {
        useFloatingChatStore.getState().setSuppressed(false);
        if (impressionTimerRef.current) clearTimeout(impressionTimerRef.current);
      };
    }, []),
  );

  // --- 600ms dwell → soft impression for the card under review. ---
  const fireImpression = useCallback((s: ForYouSuggestion) => {
    if (impressedIdsRef.current.has(s._id)) return;
    impressedIdsRef.current.add(s._id);
    void recordImpression({
      articleId: s.articleId,
      suggestionId: s._id,
      stableClusterId:
        s.clusters.find((c) => c.stableClusterId)?.stableClusterId ?? null,
      titleNorm: titleNormOf(s.title_en),
      surface: 'triage',
    });
  }, []);

  useEffect(() => {
    if (impressionTimerRef.current) clearTimeout(impressionTimerRef.current);
    if (!suggestion) return;
    if (impressedIdsRef.current.has(suggestion._id)) return;
    impressionTimerRef.current = setTimeout(
      () => fireImpression(suggestion),
      IMPRESSION_DWELL_MS,
    );
    return () => {
      if (impressionTimerRef.current) clearTimeout(impressionTimerRef.current);
    };
  }, [suggestion, fireImpression]);

  const onPressBody = useCallback(() => {
    if (suggestion) useTriageStore.getState().resolve(suggestion._id, 'read');
  }, [suggestion]);

  const closeTriage = useCallback(() => {
    router.back();
  }, []);

  const isEmpty = status === 'empty' || (status === 'active' && !suggestion);

  return (
    <Box className="flex-1 bg-black" style={{ paddingTop: insets.top }}>
      {/* Header: title + progress + close. */}
      <HStack className="items-center justify-between px-5 py-3">
        <VStack className="flex-1 min-w-0 mr-3">
          <Text size="xl" className="text-white font-semibold" numberOfLines={1}>
            {t('triage.title')}
          </Text>
          {total > 0 ? (
            <Text size="xs" className="text-typography-400">
              {t('triage.progress', { current: position, total })}
            </Text>
          ) : null}
        </VStack>
        <Pressable
          onPress={closeTriage}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={t('triage.close')}
          className="p-2 rounded-full border border-primary-500 bg-transparent"
        >
          <MaterialIcons name="close" size={22} color={ACCENT} />
        </Pressable>
      </HStack>

      {isEmpty ? (
        <VStack
          className="flex-1 items-center justify-center px-4"
          style={{ paddingBottom: insets.bottom }}
        >
          <AllCaughtUpCard />
        </VStack>
      ) : suggestion ? (
        <VStack className="flex-1 justify-center px-1" space="md">
          <TriageCard suggestion={suggestion} onPressBody={onPressBody} />
          <TriageActionBar suggestion={suggestion} />

          {/* "Up next" peek — the next card, dimmed + non-interactive. */}
          {next ? (
            <VStack className="px-3 pt-2" space="xs">
              <Text size="xs" className="text-typography-500 uppercase">
                {t('triage.upNext')}
              </Text>
              <View pointerEvents="none" style={{ opacity: 0.5 }}>
                <ArticleSuggestionCompactCard
                  suggestion={next}
                  onPress={noop}
                  surface="triage"
                />
              </View>
            </VStack>
          ) : null}
        </VStack>
      ) : (
        // Loading / uninitialized — render nothing (fast; the deck builds sync).
        <Box className="flex-1" />
      )}
    </Box>
  );
};

export default TriageScreen;
