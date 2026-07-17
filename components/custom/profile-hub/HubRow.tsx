import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';

type IconName = React.ComponentProps<typeof MaterialIcons>['name'];

interface HubRowProps {
    readonly icon: IconName;
    readonly label: string;
    readonly subtitle?: string;
    readonly iconColor?: string;
    /** Optional count pill shown before the chevron (e.g. pending hygiene items). */
    readonly badgeCount?: number;
    readonly badgeColor?: string;
    readonly onPress: () => void;
    readonly accessibilityLabel?: string;
}

/**
 * A single Profile-hub navigation row (Wave 12): leading icon, label + optional
 * subtitle, an optional count badge, and a trailing chevron. Pushes a focused
 * sub-screen. Modeled on the SettingsTabScreen "Sources" row.
 */
const HubRow: React.FC<HubRowProps> = ({
    icon,
    label,
    subtitle,
    iconColor = '#EDA77E',
    badgeCount,
    badgeColor = '#EDA77E',
    onPress,
    accessibilityLabel,
}) => {
    return (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel ?? label}
            className="flex-row items-center justify-between px-4 py-3.5 mb-3 border border-gray-700 rounded-lg"
        >
            <HStack className="items-center flex-1 mr-2" space="md">
                <MaterialIcons name={icon} size={22} color={iconColor} />
                <VStack className="flex-1">
                    <Text className="text-base text-white">{label}</Text>
                    {subtitle ? (
                        <Text size="xs" className="text-gray-500 mt-0.5" numberOfLines={1}>
                            {subtitle}
                        </Text>
                    ) : null}
                </VStack>
            </HStack>
            <HStack className="items-center" space="sm">
                {typeof badgeCount === 'number' && badgeCount > 0 ? (
                    <VStack
                        className="rounded-full items-center justify-center px-2"
                        style={{ minWidth: 22, height: 22, backgroundColor: badgeColor }}
                    >
                        <Text size="xs" className="text-black font-bold">{badgeCount}</Text>
                    </VStack>
                ) : null}
                <MaterialIcons name="chevron-right" size={20} color="#6b7280" />
            </HStack>
        </Pressable>
    );
};

export default HubRow;
