import { GlassPanel } from '@/components/custom/GlassSurface';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { ExploreScope } from '@/lib/explore/scopes';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, type ListRenderItem } from 'react-native';

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
                        <Pressable
                            onPress={() => router.push('/logged-in/sources')}
                            accessibilityRole="button"
                            accessibilityLabel={t('explore.addSources')}
                            className="flex-row items-center justify-center px-4 py-2"
                        >
                            <MaterialIcons name="add" size={16} color={ACCENT} />
                        </Pressable>
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
                <Pressable
                    onPress={() => handleRemove(scope)}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel={t('explore.removeScope', { name: label })}
                    className="absolute -top-1.5 -right-1 z-10 items-center justify-center w-5 h-5 rounded-full bg-gray-900 border border-gray-600"
                >
                    <MaterialIcons name="close" size={12} color="#ffffff" />
                </Pressable>
            ) : null;

            // Active chip keeps its solid accent fill — that fill IS the
            // selection signal, so it is never glassed. Inactive chips get
            // the Liquid Glass treatment (with the pre-glass bordered/
            // transparent look as their non-iOS-26 fallback).
            if (active) {
                return (
                    <Box className="mr-2" style={{ position: 'relative' }}>
                        <Pressable
                            onPress={() => handleSelect(scope)}
                            onLongPress={canHide ? () => setRevealedId(scope.id) : undefined}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                            accessibilityLabel={label}
                            className="flex-row items-center rounded-full border px-4 py-2 bg-primary-400 border-primary-400"
                        >
                            {chipInner}
                        </Pressable>
                        {removeOverlay}
                    </Box>
                );
            }

            return (
                <Box className="mr-2" style={{ position: 'relative' }}>
                    <GlassPanel radius={999} fallbackClassName={CHIP_FALLBACK_CLASS}>
                        <Pressable
                            onPress={() => handleSelect(scope)}
                            onLongPress={canHide ? () => setRevealedId(scope.id) : undefined}
                            accessibilityRole="button"
                            accessibilityState={{ selected: active }}
                            accessibilityLabel={label}
                            className="flex-row items-center px-4 py-2"
                        >
                            {chipInner}
                        </Pressable>
                    </GlassPanel>
                    {removeOverlay}
                </Box>
            );
        },
        [selectedId, handleSelect, handleRemove, revealedId, t],
    );

    return (
        <FlatList
            horizontal
            data={data}
            renderItem={renderItem}
            keyExtractor={(item) => item.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 4 }}
        />
    );
};

export default ScopeChipRow;
