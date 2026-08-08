import MeraLogo from '@/components/custom/MeraLogo';
import { Button, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Modal, ModalBackdrop, ModalBody, ModalContent } from '@/components/ui/modal';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import logger from '@/lib/logger';
import { isTransientNetworkError } from '@/lib/utils/transient-error';
import { MaterialIcons } from '@expo/vector-icons';
import * as Updates from 'expo-updates';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator } from 'react-native';

const ACCENT = 'rgb(231, 138, 83)'; // primary-400

/**
 * The mandatory-update takeover. Shown (by OTAUpdatePrompt) once a fetched OTA
 * update is pending: deliberately NON-closable — no close button, backdrop
 * presses are no-ops — because the alternative was a pending update riding
 * along silently until the next cold start, with the user on stale JS the
 * whole time. The only way forward is the update button, which applies the
 * already-downloaded bundle via `Updates.reloadAsync()` (an in-place restart,
 * ~a second — "forceful" but cheap, nothing is re-downloaded here).
 */
const OTAUpdateModal: React.FC<{ visible: boolean }> = ({ visible }) => {
    const { t } = useTranslation();
    const [updating, setUpdating] = useState(false);

    const applyUpdate = useCallback(() => {
        setUpdating(true);
        Updates.reloadAsync().catch((error) => {
            // reloadAsync resolving means the JS runtime restarts — this catch
            // only runs when the reload itself failed, so re-arm the button.
            setUpdating(false);
            if (isTransientNetworkError(error)) return;
            logger.captureException(error, {
                tags: { component: 'OTAUpdateModal', method: 'reloadAsync' },
            });
        });
    }, []);

    return (
        <Modal isOpen={visible} onClose={() => {}} size="lg">
            <ModalBackdrop />
            <ModalContent className="rounded-3xl border border-gray-700">
                <ModalBody className="py-8 px-2">
                    <VStack className="items-center" space="lg">
                        <MeraLogo size={96} animated />
                        {/* Update-flavoured glyph row — decorative, hidden from
                            assistive tech (the heading already says it all). */}
                        <HStack
                            space="lg"
                            className="items-center"
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                        >
                            <MaterialIcons name="system-update" size={20} color={ACCENT} />
                            <MaterialIcons name="auto-awesome" size={20} color={ACCENT} />
                            <MaterialIcons name="rocket-launch" size={20} color={ACCENT} />
                        </HStack>
                        <Heading size="2xl" className="text-white text-center">
                            {t('ota.updateReady')}
                        </Heading>
                        <Text size="md" className="text-typography-600 text-center px-4">
                            {t('ota.modalBody')}
                        </Text>
                        <Button
                            size="xl"
                            onPress={applyUpdate}
                            disabled={updating}
                            testID="ota-update-now"
                            className="w-full rounded-full mt-2"
                            style={{ backgroundColor: ACCENT, minHeight: 56 }}
                        >
                            {updating ? (
                                <ActivityIndicator color="#000000" />
                            ) : (
                                <ButtonText
                                    size="lg"
                                    className="text-black font-bold"
                                >
                                    {t('ota.updateNow')}
                                </ButtonText>
                            )}
                        </Button>
                    </VStack>
                </ModalBody>
            </ModalContent>
        </Modal>
    );
};

export default OTAUpdateModal;
