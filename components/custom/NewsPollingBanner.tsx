import MeraLogo from '@/components/custom/MeraLogo';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { useForYouSyncStatusMessage } from '@/lib/stores/selectors';
import React from 'react';
import { useTranslation } from 'react-i18next';

const BANNER_HEIGHT = 32;

export default function NewsPollingBanner() {
    const { t } = useTranslation();
    const syncStatusMessage = useForYouSyncStatusMessage();

    const isAnySyncActive =
        syncStatusMessage !== null &&
        syncStatusMessage.state !== 'idle' &&
        syncStatusMessage.state !== 'done' &&
        syncStatusMessage.state !== 'failed' &&
        syncStatusMessage.state !== 'paused-offline';

    const isStage1Active =
        syncStatusMessage?.state === 'hydrating' ||
        syncStatusMessage?.state === 'persisting';

    const tAny = t as any;
    const stage1AmberSubline = tAny('feed.processing.stages.fetching.amberSubline', { defaultValue: '' }) as string;

    if (!isAnySyncActive) return null;

    return (
        <HStack className="items-center" space="sm">
            <MeraLogo size={BANNER_HEIGHT} />
            {isStage1Active && stage1AmberSubline ? (
                <Text size="sm" className="text-amber-400">
                    {stage1AmberSubline}
                </Text>
            ) : syncStatusMessage ? (
                <Text size="sm" className="text-typography-500">
                    {t(syncStatusMessage.headlineKey as any)}
                </Text>
            ) : null}
        </HStack>
    );
}
