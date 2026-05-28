import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';

interface DrillDownHeaderProps {
    readonly title: string;
    readonly subtitle?: string;
    readonly onBack: () => void;
    readonly rightAction?: React.ReactNode;
}

const DrillDownHeader: React.FC<DrillDownHeaderProps> = ({ title, subtitle, onBack, rightAction }) => {
    return (
        <HStack className="px-4 py-3 items-center border-b border-gray-800">
            <Pressable onPress={onBack} className="p-1 -ml-1 rounded-full">
                <MaterialIcons name="arrow-back" size={22} color="#FFFFFF" />
            </Pressable>
            <VStack className="ml-2 flex-1">
                {subtitle && (
                    <Text size="xs" className="text-gray-400" numberOfLines={1}>
                        {subtitle}
                    </Text>
                )}
                <Text size="lg" className="text-white font-semibold" numberOfLines={1}>
                    {title}
                </Text>
            </VStack>
            {rightAction}
        </HStack>
    );
};

export default DrillDownHeader;
