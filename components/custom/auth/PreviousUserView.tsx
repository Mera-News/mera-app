import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { AccountService } from '@/lib/account-service';
import { clearAuthStorage } from '@/lib/auth-client';
import logger from '@/lib/logger';
import { clearAllStores } from '@/lib/stores';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface PreviousUserViewProps {
    email: string;
    userId: string;
    /**
     * Called after the user has confirmed switching accounts and the local
     * data has been wiped. Parent should re-render the email-input flow.
     */
    onUseDifferentUser: () => void;
}

/**
 * Shown on the login screen when local settings remember a previously signed-in
 * user. Lets them retry the persona fetch (recover from transient connectivity)
 * or wipe everything to switch to a different account. Avoids the gluestack
 * `<Modal>` portal layer entirely — disclaimer is rendered inline so there's no
 * zIndex / portal confusion.
 */
const PreviousUserView: React.FC<PreviousUserViewProps> = ({
    email,
    userId,
    onUseDifferentUser,
}) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();

    const [isRetrying, setIsRetrying] = useState(false);
    const [isSwitching, setIsSwitching] = useState(false);
    const [showSwitchConfirm, setShowSwitchConfirm] = useState(false);
    const [retryError, setRetryError] = useState('');

    const isBusy = isRetrying || isSwitching;

    const handleRetry = async () => {
        setRetryError('');
        setIsRetrying(true);
        try {
            const persona = await AccountService.getUserPersona(userId);
            if (!persona) {
                setRetryError(t('auth.previousUser.retryFailed'));
                return;
            }
            router.replace('/logged-in');
        } catch (err) {
            logger.captureException(err, {
                tags: { component: 'PreviousUserView', method: 'handleRetry' },
                extra: { userId },
            });
            setRetryError(t('auth.previousUser.retryFailed'));
        } finally {
            setIsRetrying(false);
        }
    };

    const handleSwitch = async () => {
        setShowSwitchConfirm(false);
        setIsSwitching(true);
        try {
            await clearAuthStorage();
            await clearAllStores();
            onUseDifferentUser();
        } catch (err) {
            logger.captureException(err, {
                tags: { component: 'PreviousUserView', method: 'handleSwitch' },
            });
            setIsSwitching(false);
        }
    };

    return (
        <Box
            className="flex-1 px-5 bg-background-0"
            style={{ paddingBottom: insets.bottom + 32 }}
        >
            <Box className="flex-1 justify-center">
                <Box className="items-center mb-8">
                    <MeraLogo size={150} />
                </Box>

                <VStack space="lg" className="mb-8">
                    <Text className="text-white text-2xl font-semibold text-center">
                        {t('auth.previousUser.title')}
                    </Text>
                    <Text className="text-gray-300 text-base text-center">
                        {t('auth.previousUser.subtitle')}
                    </Text>

                    <Box className="items-center">
                        <HStack
                            space="sm"
                            className="items-center bg-gray-800 rounded-full px-4 py-2"
                        >
                            <MaterialIcons name="account-circle" size={20} color="#a3a3a3" />
                            <Text className="text-gray-100 text-sm">{email}</Text>
                        </HStack>
                    </Box>

                    {retryError ? (
                        <Text className="text-red-400 text-sm text-center">
                            {retryError}
                        </Text>
                    ) : null}
                </VStack>

                {!showSwitchConfirm ? (
                    <VStack space="md">
                        <Button
                            action="primary"
                            onPress={handleRetry}
                            disabled={isBusy}
                            className="w-full"
                        >
                            {isRetrying ? (
                                <Spinner size="small" />
                            ) : (
                                <ButtonText>
                                    {t('auth.previousUser.retryLogin')}
                                </ButtonText>
                            )}
                        </Button>
                        <Button
                            variant="outline"
                            action="secondary"
                            onPress={() => setShowSwitchConfirm(true)}
                            disabled={isBusy}
                            className="w-full"
                        >
                            <ButtonText>
                                {t('auth.previousUser.useDifferentUser')}
                            </ButtonText>
                        </Button>
                    </VStack>
                ) : (
                    <VStack space="md">
                        <Text className="text-red-400 text-sm leading-relaxed text-center">
                            {t('auth.previousUser.switchBody')}
                        </Text>
                        <Button
                            action="negative"
                            onPress={handleSwitch}
                            disabled={isBusy}
                            className="w-full"
                        >
                            {isSwitching ? (
                                <Spinner size="small" />
                            ) : (
                                <ButtonText>
                                    {t('auth.previousUser.switchConfirm')}
                                </ButtonText>
                            )}
                        </Button>
                        <Button
                            variant="outline"
                            action="secondary"
                            onPress={() => setShowSwitchConfirm(false)}
                            disabled={isBusy}
                            className="w-full"
                        >
                            <ButtonText>
                                {t('auth.previousUser.switchCancel')}
                            </ButtonText>
                        </Button>
                    </VStack>
                )}
            </Box>
        </Box>
    );
};

export default PreviousUserView;
