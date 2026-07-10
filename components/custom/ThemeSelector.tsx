import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useThemeColors } from '@/lib/theme/tokens';
import { ThemePreference, useThemeStore } from '@/lib/stores/theme-store';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const OPTIONS: {
    preference: ThemePreference;
    icon: keyof typeof MaterialIcons.glyphMap;
    labelKey: 'theme.light' | 'theme.dark' | 'theme.system';
}[] = [
    { preference: 'light', icon: 'light-mode', labelKey: 'theme.light' },
    { preference: 'dark', icon: 'dark-mode', labelKey: 'theme.dark' },
    { preference: 'system', icon: 'settings-suggest', labelKey: 'theme.system' },
];

interface ThemeSelectorProps {
    /** Icon-only pills for tight spots (login screen popover). */
    compact?: boolean;
}

const ThemeSelector: React.FC<ThemeSelectorProps> = ({ compact = false }) => {
    const { t } = useTranslation();
    const colors = useThemeColors();
    const preference = useThemeStore((s) => s.preference);
    const setPreference = useThemeStore((s) => s.setPreference);

    return (
        <HStack space="sm">
            {OPTIONS.map((option) => {
                const selected = option.preference === preference;
                const stateClass = selected
                    ? 'border-primary-400 bg-primary-400/15'
                    : 'border-outline-100 bg-background-50';

                if (compact) {
                    return (
                        <Pressable
                            key={option.preference}
                            onPress={() => setPreference(option.preference)}
                            accessibilityRole="button"
                            accessibilityLabel={t(option.labelKey)}
                            className={`rounded-full p-2.5 border ${stateClass}`}
                        >
                            <MaterialIcons
                                name={option.icon}
                                size={20}
                                color={selected ? colors.primary : colors.iconMuted}
                            />
                        </Pressable>
                    );
                }

                return (
                    <Pressable
                        key={option.preference}
                        onPress={() => setPreference(option.preference)}
                        accessibilityRole="button"
                        accessibilityLabel={t(option.labelKey)}
                        className={`flex-1 rounded-lg px-4 py-3 border ${stateClass}`}
                    >
                        <VStack space="xs" className="items-center">
                            <MaterialIcons
                                name={option.icon}
                                size={22}
                                color={selected ? colors.primary : colors.iconMuted}
                            />
                            <Text
                                className={`text-center font-medium ${selected ? '' : 'text-typography-500'}`}
                                style={selected ? { color: colors.primary } : undefined}
                            >
                                {t(option.labelKey)}
                            </Text>
                        </VStack>
                    </Pressable>
                );
            })}
        </HStack>
    );
};

export default ThemeSelector;
