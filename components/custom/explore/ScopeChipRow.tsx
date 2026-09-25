import { GlassPanel } from '@/components/custom/GlassSurface';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { ExploreScope } from '@/lib/explore/scopes';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, StyleSheet, View, type ListRenderItem } from 'react-native';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

/** Trailing ghost "+" chip id — a sentinel appended after the real scopes,
 *  never selectable/selected, navigates to the Sources screen (Item 7 —
 *  browsing a country there no longer creates a persona Location, see
 *  lib/explore/browse-countries.ts). */
const ADD_PLACES_ID = 'add-places';

/** Fallback chrome for glass chips (add-places + unselected scopes) wherever
 *  GlassPanel can't paint real glass — matches the pre-glass flat look. The
 *  active/selected chip stays a solid accent fill (its own selection signal,
 *  not chrome) and is never wrapped in glass. */
const CHIP_FALLBACK_CLASS = 'border border-gray-700 bg-transparent';

// Every chip's visual (label, icon, flag) is hidden and a CHILDLESS labelled
// button is laid over it: a glyph inside a button surfaces on iOS as its own
// StaticText (captured class, ux2).
const HIDDEN = {
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
} as const;

// The revealed "x": a numeric 44pt frame, top-aligned with the list's own 4pt
// padding (no higher, or the list clips it) and right-aligned with the chip's
// mr-2 gap. The 17.5pt circle (w-5 at 14pt rem) keeps its old place: 5.25pt
// above the chip and 3.5pt past its right edge (-top-1.5, -right-1).
const REMOVE_TARGET = 44;
const REMOVE_FRAME_TOP = -4;
const REMOVE_FRAME_RIGHT = -7;
const REMOVE_CIRCLE = 17.5;
const REMOVE_FRAME_STYLE = {
    position: 'absolute',
    top: REMOVE_FRAME_TOP,
    right: REMOVE_FRAME_RIGHT,
    width: REMOVE_TARGET,
    height: REMOVE_TARGET,
    zIndex: 10,
} as const;
const REMOVE_CIRCLE_STYLE = {
    position: 'absolute',
    top: -5.25 - REMOVE_FRAME_TOP,
    right: -3.5 - REMOVE_FRAME_RIGHT,
    width: REMOVE_CIRCLE,
    height: REMOVE_CIRCLE,
} as const;

type ChipItem = ExploreScope | { readonly id: typeof ADD_PLACES_ID };

interface ScopeChipRowProps {
    readonly scopes: readonly ExploreScope[];
    readonly selectedId: string;
    readonly onSelect: (scope: ExploreScope) => void;
    /**
     * Long-press → tap-the-"×" removal (Item 18). Called with the scope to
     * remove. Never called for `world` (not hideable — see the `canHide`
     * guard below). The caller decides what "remove" means for a given
     * scope: a browse-added country is dropped from the browse set outright;
     * a location-derived one is only suppressed (the location itself, and
     * its geo-scoring signal, are left alone).
     */
    readonly onRemove: (scope: ExploreScope) => void;
}

/**
 * Horizontal, icon-first scope selector for the Explore tab. Country/city/
 * region/World chips derived from the user's locations + device country (see
 * lib/explore/scopes) — the primary country leads and World is always last.
 * Country chips lead with the flag emoji; the rest (World, city, region) use
 * a MaterialIcon. The active chip fills with the accent.
 *
 * Long-press any non-World chip to reveal a small "×" overlay; tapping it
 * calls `onRemove`. This is a *separate* gesture from the tap-to-select
 * `onPress` — RN's Pressable does not also fire `onPress` once a gesture has
 * already resolved as `onLongPress`, so revealing the "×" never fights
 * selection.
 */
const ScopeChipRow: React.FC<ScopeChipRowProps> = ({ scopes, selectedId, onSelect, onRemove }) => {
    const { t } = useTranslation();

    // Trailing ghost "+" chip, appended as a sentinel item so it rides the
    // same FlatList/renderItem as the real scope chips — never selectable.
    const data = useMemo<ChipItem[]>(() => [...scopes, { id: ADD_PLACES_ID }], [scopes]);

    // Which chip (if any) currently shows its "×" overlay. Reset whenever the
    // scope set changes — a chip that just got removed (or a whole new set
    // arrived on refocus) must not leave a stale "×" floating over whatever
    // now occupies that slot.
    const [revealedId, setRevealedId] = useState<string | null>(null);
    useEffect(() => {
        setRevealedId(null);
    }, [scopes]);

    const handleSelect = useCallback(
        (scope: ExploreScope) => {
            // A tap-to-select always dismisses any revealed "×" — selecting a
            // chip (even re-tapping the revealed one) is a clear signal the
            // user is done with the long-press affordance.
            setRevealedId(null);
            onSelect(scope);
        },
        [onSelect],
    );

    // Keep the SELECTED chip on screen: a swipe (ux2 B3) can select a scope
    // whose chip is scrolled off, which would leave the row showing a
    // different chip as the current one. Only on change; `viewPosition` 0.5
    // centres it. A not-yet-measured index falls back to a rough offset.
    const listRef = useRef<FlatList<ChipItem>>(null);
    useEffect(() => {
        const index = data.findIndex((item) => item.id === selectedId);
        if (index < 0) return;
        listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
    }, [selectedId, data]);

    const handleRemove = useCallback(
        (scope: ExploreScope) => {
            setRevealedId(null);
            onRemove(scope);
        },
        [onRemove],
    );

    const renderItem: ListRenderItem<ChipItem> = useCallback(
        ({ item }) => {
            if (item.id === ADD_PLACES_ID) {
                // Ghost "+" chip is never "selected" — always glass (or its
                // flat fallback), never the solid accent fill.
                return (
                    <GlassPanel radius={999} className="mr-2" fallbackClassName={CHIP_FALLBACK_CLASS}>
                        <View>
                            <View pointerEvents="none" {...HIDDEN} className="flex-row items-center justify-center px-4 py-2">
                                <MaterialIcons name="add" size={16} color={ACCENT} {...HIDDEN} />
                            </View>
                            <Pressable
                                onPress={() => router.push('/logged-in/sources')}
                                accessibilityRole="button"
                                accessibilityLabel={t('explore.addSources')}
                                style={StyleSheet.absoluteFill}
                            />
                        </View>
                    </GlassPanel>
                );
            }

            const scope = item as ExploreScope;
            const active = scope.id === selectedId;
            const label = scope.kind === 'world' ? t('explore.scopeWorld') : scope.label;
            // World carries no location/browse signal to hide behind — it is
            // never removable, so it never enters the long-press/"×" flow.
            const canHide = scope.kind !== 'world';
            const revealed = canHide && revealedId === scope.id;
            const chipInner = (
                <>
                    {scope.kind === 'country' && scope.flagEmoji ? (
                        <Text className="text-base mr-1.5">{scope.flagEmoji}</Text>
                    ) : (
                        <MaterialIcons
                            name={scope.icon}
                            size={16}
                            color={active ? '#000000' : ACCENT}
                            style={{ marginRight: 6 }}
                            {...HIDDEN}
                        />
                    )}
                    <Text
                        size="sm"
                        numberOfLines={1}
                        className={active ? 'text-black font-semibold' : 'text-white'}
                    >
                        {label}
                    </Text>
                </>
            );

            const removeOverlay = revealed ? (
                <View testID="explore-scope-remove-frame" style={REMOVE_FRAME_STYLE}>
                    <View
                        pointerEvents="none"
                        {...HIDDEN}
                        className="items-center justify-center rounded-full bg-gray-900 border border-gray-600"
                        style={REMOVE_CIRCLE_STYLE}
                    >
                        <MaterialIcons name="close" size={12} color="#ffffff" {...HIDDEN} />
                    </View>
                    <Pressable
                        onPress={() => handleRemove(scope)}
                        accessibilityRole="button"
                        accessibilityLabel={t('explore.removeScope', { name: label })}
                        style={StyleSheet.absoluteFill}
                    />
                </View>
            ) : null;

            // Active chip keeps its solid accent fill — that fill IS the
            // selection signal, so it is never glassed. Inactive chips get
            // the Liquid Glass treatment (with the pre-glass bordered/
            // transparent look as their non-iOS-26 fallback).
            if (active) {
                return (
                    <Box className="mr-2" style={{ position: 'relative' }}>
                        <View>
                            <View pointerEvents="none" {...HIDDEN} className="flex-row items-center rounded-full border px-4 py-2 bg-primary-400 border-primary-400">
                                {chipInner}
                            </View>
                            <Pressable
                                onPress={() => handleSelect(scope)}
                                onLongPress={canHide ? () => setRevealedId(scope.id) : undefined}
                                accessibilityRole="button"
                                accessibilityState={{ selected: active }}
                                accessibilityLabel={label}
                                style={StyleSheet.absoluteFill}
                            />
                        </View>
                        {removeOverlay}
                    </Box>
                );
            }

            return (
                <Box className="mr-2" style={{ position: 'relative' }}>
                    <GlassPanel radius={999} fallbackClassName={CHIP_FALLBACK_CLASS}>
                        <View>
                            <View pointerEvents="none" {...HIDDEN} className="flex-row items-center px-4 py-2">
                                {chipInner}
                            </View>
                            <Pressable
                                onPress={() => handleSelect(scope)}
                                onLongPress={canHide ? () => setRevealedId(scope.id) : undefined}
                                accessibilityRole="button"
                                accessibilityState={{ selected: active }}
                                accessibilityLabel={label}
                                style={StyleSheet.absoluteFill}
                            />
                        </View>
                    </GlassPanel>
                    {removeOverlay}
                </Box>
            );
        },
        [selectedId, handleSelect, handleRemove, revealedId, t],
    );

    return (
        <FlatList
            ref={listRef}
            horizontal
            data={data}
            onScrollToIndexFailed={({ averageItemLength, index }) =>
                listRef.current?.scrollToOffset({ offset: averageItemLength * index, animated: true })
            }
            renderItem={renderItem}
            keyExtractor={(item) => item.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 4 }}
        />
    );
};

export default ScopeChipRow;
