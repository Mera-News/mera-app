import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { ExploreScope } from '@/lib/explore/scopes';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, type ListRenderItem } from 'react-native';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

interface ScopeChipRowProps {
    readonly scopes: readonly ExploreScope[];
    readonly selectedId: string;
    readonly onSelect: (scope: ExploreScope) => void;
}

/**
 * Horizontal, icon-first scope selector for the Explore tab. World/country/
 * city/region chips derived from the user's locations + device country (see
 * lib/explore/scopes). Country chips lead with the flag emoji; the rest use a
 * MaterialIcon. The active chip fills with the accent.
 */
const ScopeChipRow: React.FC<ScopeChipRowProps> = ({ scopes, selectedId, onSelect }) => {
    const { t } = useTranslation();

    const renderItem: ListRenderItem<ExploreScope> = useCallback(
        ({ item }) => {
            const active = item.id === selectedId;
            const label = item.kind === 'world' ? t('explore.scopeWorld') : item.label;
            return (
                <Pressable
                    onPress={() => onSelect(item)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={label}
                    className={`flex-row items-center rounded-full border px-4 py-2 mr-2 ${
                        active ? 'bg-primary-400 border-primary-400' : 'border-gray-700 bg-transparent'
                    }`}
                >
                    {item.kind === 'country' && item.flagEmoji ? (
                        <Text className="text-base mr-1.5">{item.flagEmoji}</Text>
                    ) : (
                        <MaterialIcons
                            name={item.icon}
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
            data={scopes as ExploreScope[]}
            renderItem={renderItem}
            keyExtractor={(item) => item.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 4 }}
        />
    );
};

export default ScopeChipRow;
