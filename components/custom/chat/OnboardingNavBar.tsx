import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface OnboardingNavBarProps {
    onBack?: () => void;
    onSkip?: () => void;
    skipLabel?: string;
    skipDisabled?: boolean;
    stepLabel?: string;
}

const OnboardingNavBar: React.FC<OnboardingNavBarProps> = ({
    onBack,
    onSkip,
    skipLabel,
    skipDisabled = false,
    stepLabel,
}) => {
    const { t } = useTranslation();
    const resolvedSkipLabel = skipLabel ?? t('onboarding.nextStep');
    if (!onBack && !onSkip) return null;

    return (
        <HStack className="px-5 py-3 justify-between items-center">
            {onBack ? (
                <Button
                    variant="outline"
                    action="secondary"
                    size="sm"
                    onPress={onBack}
                >
                    <ButtonText>{t('common.back')}</ButtonText>
                </Button>
            ) : (
                <Box />
            )}
            {stepLabel ? (
                <Text size="sm" className="text-typography-500">
                    {stepLabel}
                </Text>
            ) : (
                <Box />
            )}
            {onSkip ? (
                <Button
                    action="primary"
                    variant="solid"
                    size="sm"
                    onPress={onSkip}
                    isDisabled={skipDisabled}
                >
                    <ButtonText>{resolvedSkipLabel}</ButtonText>
                </Button>
            ) : (
                <Box />
            )}
        </HStack>
    );
};

export default OnboardingNavBar;
