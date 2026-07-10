import StreamingIndicator from '@/components/custom/chat/StreamingIndicator';
import { Box } from '@/components/ui/box';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';

const OnboardingWaitingCard: React.FC = () => {
    const { t } = useTranslation();
    return (
        <Card
            variant="elevated"
            size="md"
            className="mb-4 overflow-hidden bg-background-0 border-background-0"
        >
            <Box className="w-full py-12 px-6 items-center justify-center">
                <StreamingIndicator />
                <Text
                    size="md"
                    className="text-typography-500 text-center mt-4"
                >
                    {t('onboarding.completionMessage')}
                </Text>
            </Box>
        </Card>
    );
};

export default OnboardingWaitingCard;
