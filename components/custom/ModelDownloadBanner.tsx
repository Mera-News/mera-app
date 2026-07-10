import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Progress, ProgressFilledTrack } from '@/components/ui/progress';
import { Text } from '@/components/ui/text';
import { useDownloadProgress, useModelState } from '@/lib/stores/mera-protocol-store';
import { useThemeColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ModelDownloadBanner: React.FC = () => {
    const { t } = useTranslation();
    const colors = useThemeColors();
    const modelState = useModelState();
    const downloadProgress = useDownloadProgress();

    if (modelState !== 'downloading') return null;

    return (
        <Box className="px-4 py-3 bg-background-50 border-t border-outline-50">
            <HStack className="items-center mb-2" space="sm">
                <MaterialIcons name="cloud-download" size={16} color={colors.primary} />
                <Text className="text-primary-300 font-medium flex-1" size="sm">
                    {t('download.modelDownloading')}
                </Text>
                <Text className="text-typography-500" size="xs">
                    {t('download.modelProgress', { percent: downloadProgress })}
                </Text>
            </HStack>
            <Progress value={downloadProgress} size="xs">
                <ProgressFilledTrack className="bg-primary-500" />
            </Progress>
        </Box>
    );
};

export default ModelDownloadBanner;
