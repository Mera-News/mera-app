import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
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
    return (
        <HStack className="px-4 py-3 items-center border-b border-gray-800">
            {/* hitSlop, and an explicit accessibilityRole/label. A 22pt glyph
                with `p-1` is a ~30x30 target — under Apple's 44pt minimum — and
                this is the back control for EVERY config-panel drill-down. The
                visually identical buttons in SecuritySettingsScreen and
                DisplaySettingsScreen already pass hitSlop; the pattern was
                known, this one instance just never got it. 12 brings the
                effective target to ~54x54. */}
            <Pressable
                onPress={onBack}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={title}
                className="p-1 -ml-1 rounded-full"
            >
                <MaterialIcons name="arrow-back" size={22} color="#FFFFFF" />
            </Pressable>
            <VStack className="ml-2 flex-1">
                {subtitle && (
                    <Text size="xs" className="text-gray-400" numberOfLines={1}>
                        {subtitle}
                    </Text>
                )}
                {titleContent ?? (
                    <Text size="lg" className="text-white font-semibold" numberOfLines={titleNumberOfLines}>
                        {title}
                    </Text>
                )}
            </VStack>
            {rightAction}
        </HStack>
    );
};

export default DrillDownHeader;
