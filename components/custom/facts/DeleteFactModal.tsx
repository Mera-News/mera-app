import { Button, ButtonText } from '@/components/ui/button';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface DeleteFactModalProps {
    readonly fact: Fact | null;
    readonly isDeleting: boolean;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
}

/** Delete-fact confirmation modal (Wave 12 extraction). */
const DeleteFactModal: React.FC<DeleteFactModalProps> = ({ fact, isDeleting, onConfirm, onCancel }) => {
    const { t } = useTranslation();
    return (
        <Modal isOpen={fact !== null} onClose={onCancel} size="sm">
            <ModalBackdrop />
            <ModalContent>
                <ModalHeader className="border-gray-700 pb-4">
                    <Text className="text-xl font-semibold text-red-400">{t('configPanel.deleteFactTitle')}</Text>
                </ModalHeader>
                <ModalBody className="py-6">
                    <Text className="text-gray-300 text-base leading-relaxed mb-4">
                        {t('configPanel.deleteFactConfirm')}
                    </Text>
                    {fact && (
                        <Text className="text-white text-base font-medium mb-4 capitalize">
                            &ldquo;{fact.statement}&rdquo;
                        </Text>
                    )}
                    <Text className="text-red-400 text-sm font-medium">
                        {t('configPanel.deleteFactWarning')}
                    </Text>
                </ModalBody>
                <ModalFooter className="border-t border-gray-700 pt-4">
                    <VStack className="w-full" space="md">
                        <Button
                            action="negative"
                            onPress={onConfirm}
                            disabled={isDeleting}
                            className="w-full"
                        >
                            <ButtonText>
                                {isDeleting ? t('configPanel.deletingFact') : t('configPanel.yesDelete')}
                            </ButtonText>
                        </Button>
                        <Button
                            variant="outline"
                            action="secondary"
                            onPress={onCancel}
                            disabled={isDeleting}
                            className="w-full"
                        >
                            <ButtonText>{t('common.cancel')}</ButtonText>
                        </Button>
                    </VStack>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
};

export default DeleteFactModal;
