import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { getDisplaySectionLabel, getRelevanceColors } from '@/lib/relevance-utils';
import React from 'react';

interface PriorityLabelCardProps {
    label: string;
    relevance: number;
}

const PriorityLabelCard: React.FC<PriorityLabelCardProps> = ({ label, relevance }) => {
    const colors = getRelevanceColors(relevance);

    return (
        <Card variant="elevated" size="md" className="mb-4">
            <Text
                className="font-bold"
                style={{
                    color: colors.borderColor,
                }}
                size="lg"
            >
                {getDisplaySectionLabel(label)}
            </Text>
        </Card>
    );
};

export default PriorityLabelCard;
