import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Progress, ProgressFilledTrack } from '@/components/ui/progress';
import { Text } from '@/components/ui/text';
import { useDownloadProgress, useModelState } from '@/lib/stores/mera-protocol-store';
import { useThemeMode } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ModelDownloadBanner: React.FC = () => {
    const { t } = useTranslation();
    const modelState = useModelState();
    const downloadProgress = useDownloadProgress();
    // Violet is this banner's own colour; light takes a deeper one for 4.5:1.
    const light = useThemeMode() === 'light';

    if (modelState !== 'downloading') return null;

    return (
        <Box className={`px-4 py-3 border-t ${light ? 'bg-panel border-line' : 'bg-zinc-900 border-zinc-800'}`}>
            <HStack className="items-center mb-2" space="sm">
                <MaterialIcons name="cloud-download" size={16} color={light ? '#6D28D9' : '#a78bfa'} />
                <Text className={`font-medium flex-1 ${light ? 'text-violet-700' : 'text-purple-300'}`} size="sm">
                    {t('download.modelDownloading')}
                </Text>
                <Text className={light ? 'text-ink-2' : 'text-zinc-400'} size="xs">
                    {t('download.modelProgress', { percent: downloadProgress })}
                </Text>
            </HStack>
            <Progress value={downloadProgress} size="xs">
                <ProgressFilledTrack className="bg-purple-500" />
            </Progress>
        </Box>
    );
};

export default ModelDownloadBanner;
