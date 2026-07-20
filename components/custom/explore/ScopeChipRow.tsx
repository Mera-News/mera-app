import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { ExploreScope } from '@/lib/explore/scopes';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, type ListRenderItem } from 'react-native';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

/** Trailing ghost "+" chip id — a sentinel appended after the real scopes,
 *  never selectable/selected, navigates to the locations screen. */
const ADD_PLACES_ID = 'add-places';

type ChipItem = ExploreScope | { readonly id: typeof ADD_PLACES_ID };

interface ScopeChipRowProps {
    readonly scopes: readonly ExploreScope[];
    readonly selectedId: string;
    readonly onSelect: (scope: ExploreScope) => void;
}

/**
 * Horizontal, icon-first scope selector for the Explore tab. Top stories/
 * World/country/city/region chips derived from the user's locations + device
 * country (see lib/explore/scopes). Country chips lead with the flag emoji;
 * the rest (Top stories, World, city, region) use a MaterialIcon. The active
 * chip fills with the accent.
 */
const ScopeChipRow: React.FC<ScopeChipRowProps> = ({ scopes, selectedId, onSelect }) => {
    const { t } = useTranslation();

    // Trailing ghost "+" chip, appended as a sentinel item so it rides the
    // same FlatList/renderItem as the real scope chips — never selectable.
    const data = useMemo<ChipItem[]>(() => [...scopes, { id: ADD_PLACES_ID }], [scopes]);

    const renderItem: ListRenderItem<ChipItem> = useCallback(
        ({ item }) => {
            if (item.id === ADD_PLACES_ID) {
                return (
                    <Pressable
                        onPress={() => router.push('/logged-in/locations')}
                        accessibilityRole="button"
                        accessibilityLabel={t('explore.addPlaces')}
                        className="flex-row items-center justify-center rounded-full border px-4 py-2 mr-2 border-gray-700 bg-transparent"
                    >
                        <MaterialIcons name="add" size={16} color={ACCENT} />
                    </Pressable>
                );
            }

            const scope = item as ExploreScope;
            const active = scope.id === selectedId;
            const label =
                scope.kind === 'top'
                    ? t('explore.scopeTopStories')
                    : scope.kind === 'world'
                      ? t('explore.scopeWorld')
                      : scope.label;
            return (
                <Pressable
                    onPress={() => onSelect(scope)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={label}
                    className={`flex-row items-center rounded-full border px-4 py-2 mr-2 ${
                        active ? 'bg-primary-400 border-primary-400' : 'border-gray-700 bg-transparent'
                    }`}
                >
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
                </Pressable>
            );
        },
        [selectedId, onSelect, t],
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
