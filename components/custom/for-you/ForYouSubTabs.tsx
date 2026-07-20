import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { observeUnseenTotal } from '@/lib/database/services/tracked-story-service';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

export type ForYouSubTab = 'feed' | 'stories' | 'saved';

interface ForYouSubTabsProps {
    readonly activeSubTab: ForYouSubTab;
    readonly onSelect: (tab: ForYouSubTab) => void;
}

interface TabDef {
    readonly key: ForYouSubTab;
    readonly icon: keyof typeof MaterialIcons.glyphMap;
    readonly labelKey: string;
}

const TABS: readonly TabDef[] = [
    { key: 'feed', icon: 'dynamic-feed', labelKey: 'forYou.subTabFeed' },
    { key: 'stories', icon: 'auto-awesome', labelKey: 'forYou.subTabStories' },
    { key: 'saved', icon: 'bookmark', labelKey: 'forYou.subTabSaved' },
];

/**
 * The For-You sub-tab pill row — `[Feed] [Stories ●n] [Saved]`. Pill styling
 * mirrors Explore's ScopeChipRow (accent border, accent-filled active chip). The
 * Stories pill carries a live badge with the total unseen tracked-story count,
 * subscribed here so it stays fresh without the parent re-rendering.
 */
const ForYouSubTabs: React.FC<ForYouSubTabsProps> = ({ activeSubTab, onSelect }) => {
    const { t } = useTranslation();
    const [unseenTotal, setUnseenTotal] = useState(0);

    useEffect(() => {
        const sub = observeUnseenTotal().subscribe({
            next: (total) => setUnseenTotal(total),
            error: () => setUnseenTotal(0),
        });
        return () => sub.unsubscribe();
    }, []);

    return (
        <HStack className="items-center" space="sm">
            {TABS.map((tab) => {
                const active = tab.key === activeSubTab;
                const showBadge = tab.key === 'stories' && unseenTotal > 0;
                return (
                    <Pressable
                        key={tab.key}
                        onPress={() => onSelect(tab.key)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={t(tab.labelKey as any)}
                        className={`flex-row items-center rounded-full border px-4 py-2 ${
                            active ? 'bg-primary-400 border-primary-400' : 'border-primary-500 bg-transparent'
                        }`}
                    >
                        <MaterialIcons
                            name={tab.icon}
                            size={16}
                            color={active ? '#000000' : ACCENT}
                            style={{ marginRight: 6 }}
                        />
                        <Text
                            size="sm"
                            numberOfLines={1}
                            className={active ? 'text-black font-semibold' : 'text-primary-500 font-semibold'}
                        >
                            {t(tab.labelKey as any)}
                        </Text>
                        {showBadge && (
                            <View
                                accessibilityLabel={`${unseenTotal}`}
                                className="ml-1.5 rounded-full items-center justify-center px-1.5"
                                style={{
                                    minWidth: 18,
                                    height: 18,
                                    backgroundColor: active ? '#000000' : ACCENT,
                                }}
                            >
                                <Text
                                    size="xs"
                                    className={active ? 'text-primary-400 font-bold' : 'text-black font-bold'}
                                >
                                    {unseenTotal > 99 ? '99+' : unseenTotal}
                                </Text>
                            </View>
                        )}
                    </Pressable>
                );
            })}
        </HStack>
    );
};

export default ForYouSubTabs;
