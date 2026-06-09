import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface FeedSyncLastUpdateTextProps {
    lastProcessedLabel: string | null;
}

export default function FeedSyncLastUpdateText({ lastProcessedLabel }: FeedSyncLastUpdateTextProps) {
    const { t } = useTranslation();
    if (!lastProcessedLabel) return null;
    return (
        <Text size="sm" className="text-gray-400">
            {t('feed.updatedAt', { time: lastProcessedLabel })}
        </Text>
    );
}
