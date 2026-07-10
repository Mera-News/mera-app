import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useThemeColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';

interface DrillDownHeaderProps {
    readonly title: string;
    readonly titleContent?: React.ReactNode;
    readonly subtitle?: string;
    readonly titleNumberOfLines?: number;
    readonly onBack: () => void;
    readonly rightAction?: React.ReactNode;
}

const DrillDownHeader: React.FC<DrillDownHeaderProps> = ({ title, titleContent, subtitle, titleNumberOfLines = 1, onBack, rightAction }) => {
    const colors = useThemeColors();
    return (
        <HStack className="px-4 py-3 items-center border-b border-outline-50">
            <Pressable onPress={onBack} className="p-1 -ml-1 rounded-full">
                <MaterialIcons name="arrow-back" size={22} color={colors.icon} />
            </Pressable>
            <VStack className="ml-2 flex-1">
                {subtitle && (
                    <Text size="xs" className="text-typography-500" numberOfLines={1}>
                        {subtitle}
                    </Text>
                )}
                {titleContent ?? (
                    <Text size="lg" className="text-typography-950 font-semibold" numberOfLines={titleNumberOfLines}>
                        {title}
                    </Text>
                )}
            </VStack>
            {rightAction}
        </HStack>
    );
};

export default DrillDownHeader;
