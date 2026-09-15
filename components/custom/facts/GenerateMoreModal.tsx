import { Button, ButtonText } from '@/components/ui/button';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface GenerateMoreModalProps {
    readonly isOpen: boolean;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
}

/** Generate-more-topics confirmation modal (Wave 12 extraction). */
const GenerateMoreModal: React.FC<GenerateMoreModalProps> = ({ isOpen, onConfirm, onCancel }) => {
    const { t } = useTranslation();
    return (
        <Modal isOpen={isOpen} onClose={onCancel} size="sm">
            <ModalBackdrop />
            <ModalContent>
                <ModalHeader className="pb-4">
                    <Text className="text-xl font-semibold text-white">{t('configPanel.generateMoreTopicsTitle')}</Text>
                </ModalHeader>
                <ModalBody className="py-4">
                    <Text className="text-gray-300 text-base leading-relaxed">
                        {t('configPanel.generateMoreTopicsWarning')}
                    </Text>
                </ModalBody>
                <ModalFooter className="border-t border-gray-700 pt-4">
                    <VStack className="w-full" space="md">
                        <Button onPress={onConfirm} className="w-full">
                            <ButtonText>{t('configPanel.generateMoreTopicsConfirm')}</ButtonText>
                        </Button>
                        <Button
                            variant="outline"
                            action="secondary"
                            onPress={onCancel}
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

export default GenerateMoreModal;
