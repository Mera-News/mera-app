import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { getRelevanceColors } from '@/lib/relevance-utils';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface RelevanceChipProps {
    relevance: number;
}

const RelevanceChip: React.FC<RelevanceChipProps> = ({ relevance }) => {
    const { t } = useTranslation();
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
                {t(colors.label as any)}
            </Text>
        </Box>
    );
};

export default RelevanceChip;
