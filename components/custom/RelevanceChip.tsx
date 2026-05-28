import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { getRelevanceColors } from '@/lib/relevance-utils';
import React from 'react';

interface RelevanceChipProps {
    relevance: number;
}

const RelevanceChip: React.FC<RelevanceChipProps> = ({ relevance }) => {
    const colors = getRelevanceColors(relevance);

    return (
        <Box
            className="px-2 py-1 rounded-full"
            style={{ backgroundColor: colors.backgroundColor }}
        >
            <Text
                size="xs"
                style={{
                    color: colors.textColor,
                    fontWeight: '600',
                    fontSize: 11
                }}
            >
                {colors.label}
            </Text>
        </Box>
    );
};

export default RelevanceChip;
