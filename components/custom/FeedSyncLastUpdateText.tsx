import { Text } from '@/components/ui/text';
import React from 'react';

interface FeedSyncLastUpdateTextProps {
    lastProcessedLabel: string | null;
}

export default function FeedSyncLastUpdateText({ lastProcessedLabel }: FeedSyncLastUpdateTextProps) {
    if (!lastProcessedLabel) return null;
    return (
        <Text size="sm" className="text-gray-400">
            {`Updated ${lastProcessedLabel}`}
        </Text>
    );
}
