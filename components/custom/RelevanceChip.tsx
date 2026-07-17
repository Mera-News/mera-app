import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { getRelevanceColors } from '@/lib/relevance-utils';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface RelevanceChipProps {
    relevance: number;
}

/**
 * Per-tier icon so the chip is never color-only (a11y decision, Wave 7c N2):
 * emergency `warning`, high `arrow-upward`, medium `remove`, low
 * `arrow-downward`. Thresholds mirror `getRelevanceColors`.
 */
function tierIcon(relevance: number): keyof typeof MaterialIcons.glyphMap {
    if (relevance > 1.0) return 'warning';
    if (relevance >= 0.77) return 'arrow-upward';
    if (relevance >= 0.53) return 'remove';
    if (relevance > 0.3) return 'arrow-downward';
    return 'remove';
}

const RelevanceChip: React.FC<RelevanceChipProps> = ({ relevance }) => {
    const { t } = useTranslation();
    const colors = getRelevanceColors(relevance);

    return (
        <Box
            className="px-2 py-1 rounded-full"
            style={{ backgroundColor: colors.backgroundColor }}
        >
            <HStack className="items-center" space="xs">
                <MaterialIcons
                    name={tierIcon(relevance)}
                    size={11}
                    color={colors.textColor}
                />
                <Text
                    size="xs"
                    style={{
                        color: colors.textColor,
                        fontWeight: '600',
                        fontSize: 11
                    }}
                >
                    {t(colors.label as any)}
                </Text>
            </HStack>
        </Box>
    );
};

export default RelevanceChip;
