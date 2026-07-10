import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface BlockedBannerProps {
    reason?: string | null;
}

const BlockedBanner: React.FC<BlockedBannerProps> = ({ reason }) => {
    const { t } = useTranslation();
    const colors = useThemeColors();
    return (
        <Box className="mx-4 my-2 p-4 rounded-xl bg-error-900/30 border border-error-800/50">
            <HStack className="items-center" space="sm">
                <MaterialIcons name="block" size={20} color={colors.error} />
                <Box className="flex-1">
                    <Text className="text-error-500 font-semibold" size="sm">
                        {t('errors.accountRestricted')}
                    </Text>
                    <Text className="text-error-300/80 mt-1" size="xs">
                        {reason || t('errors.accountRestrictedDescription')}
                    </Text>
                </Box>
            </HStack>
        </Box>
    );
};

export default BlockedBanner;
