import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { VStack } from '@/components/ui/vstack';
import { Icon, AlertCircleIcon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useForYouDailyLimitResetAt } from '@/lib/stores/selectors';
import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Persistent notice shown when the user has hit their daily article-delivery
 * cap. The server can't send new articles until the cap resets (00:00 UTC), so
 * we tell the user to browse what's already on-device and when more unlock.
 *
 * Driven by the sticky `dailyLimitResetAt` store value (set by FeedSyncMachine
 * when a sync is fully blocked, cleared when a sync delivers again). Self-hides
 * once the reset time has passed.
 */
/**
 * @deprecated Superseded by FeedStatusShimmer (amber tint) + FeedStatusSheet
 * (2026-07-20). The daily-limit notice now lives in the feed-status sheet. Kept
 * for reference; not mounted by any live screen.
 */
export default function DailyLimitForYouBanner() {
    const { t } = useTranslation();
    const resetAt = useForYouDailyLimitResetAt();

    if (resetAt == null || Date.now() >= resetAt) return null;

    const time = new Date(resetAt).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
    });

    return (
        <Box className="bg-warning-900 rounded-lg px-3 py-2">
            <HStack space="sm" className="items-start">
                <Icon as={AlertCircleIcon} size="sm" className="text-warning-400 mt-0.5" />
                <VStack className="flex-1" space="xs">
                    <Text size="sm" className="text-warning-400 font-semibold">
                        {t('feed.dailyLimit.title')}
                    </Text>
                    <Text size="xs" className="text-typography-300 leading-4">
                        {t('feed.dailyLimit.bodyWithTime', { time })}
                    </Text>
                </VStack>
            </HStack>
        </Box>
    );
}
