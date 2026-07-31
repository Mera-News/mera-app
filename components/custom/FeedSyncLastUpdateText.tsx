import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface FeedSyncLastUpdateTextProps {
    lastProcessedLabel: string | null;
}

export default function FeedSyncLastUpdateText({ lastProcessedLabel }: FeedSyncLastUpdateTextProps) {
    const { t } = useTranslation();
    if (!lastProcessedLabel) return null;
    // Brighter than the usual muted grey: this sits inside the Dashboard's
    // glass header, over a moving gradient with content scrolling behind it,
    // where gray-400 was hard to read.
    return (
        <Text size="sm" className="text-gray-200 font-medium" numberOfLines={1}>
            {t('feed.updatedAt', { time: lastProcessedLabel })}
        </Text>
    );
}
