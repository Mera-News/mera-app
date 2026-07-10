import { Box } from '@/components/ui/box';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';
import MeraLogo from './MeraLogo';

const NoGeneratedInterestsCard: React.FC = () => {
    const { t } = useTranslation();
    return (
        <Card
            variant="elevated"
            size="md"
            className="mb-4 overflow-hidden bg-background-0 border-background-0"
        >
            <Box className="w-full py-20 px-6 items-center justify-center">
                {/* Mera Logo */}
                <Box className="mb-6">
                    <MeraLogo size={100} />
                </Box>

                {/* Main message */}
                <Text
                    size="xl"
                    className="text-typography-950 text-center mb-4 font-semibold"
                >
                    {t('feed.noInterests')}
                </Text>

                {/* Secondary message */}
                <Text
                    size="md"
                    className="text-typography-500 text-center"
                >
                    {t('feed.noInterestsDescription')}
                </Text>
            </Box>
        </Card>
    );
};

export default NoGeneratedInterestsCard;
