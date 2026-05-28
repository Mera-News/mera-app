import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Progress, ProgressFilledTrack } from '@/components/ui/progress';
import { Text } from '@/components/ui/text';
import { useDownloadProgress, useModelState } from '@/lib/stores/mera-protocol-store';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ModelDownloadBanner: React.FC = () => {
    const { t } = useTranslation();
    const modelState = useModelState();
    const downloadProgress = useDownloadProgress();

    if (modelState !== 'downloading') return null;

    return (
        <Box className="px-4 py-3 bg-zinc-900 border-t border-zinc-800">
            <HStack className="items-center mb-2" space="sm">
                <MaterialIcons name="cloud-download" size={16} color="#a78bfa" />
                <Text className="text-purple-300 font-medium flex-1" size="sm">
                    {t('download.modelDownloading')}
                </Text>
                <Text className="text-zinc-400" size="xs">
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
