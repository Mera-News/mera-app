import { Button, ButtonText } from '@/components/ui/button';
import { Input, InputField } from '@/components/ui/input';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface AddTopicModalProps {
    readonly isOpen: boolean;
    readonly value: string;
    readonly isAdding: boolean;
    readonly onChangeText: (text: string) => void;
    readonly onConfirm: () => void;
    readonly onCancel: () => void;
}

/** Add-a-topic modal (Wave 12 extraction from PersonaL1MeraProtocol). */
const AddTopicModal: React.FC<AddTopicModalProps> = ({
    isOpen,
    value,
    isAdding,
    onChangeText,
    onConfirm,
    onCancel,
}) => {
    const { t } = useTranslation();
    return (
        <Modal isOpen={isOpen} onClose={onCancel} size="sm">
            <ModalBackdrop />
            <ModalContent>
                <ModalHeader className="pb-4">
                    <Text className="text-xl font-semibold text-white">{t('configPanel.addTopic')}</Text>
                </ModalHeader>
                <ModalBody className="py-4">
                    <Text className="text-gray-400 text-sm mb-4">
                        {t('configPanel.addTopicDescription')}
                    </Text>
                    <Input>
                        <InputField
                            placeholder={t('configPanel.addTopicPlaceholder')}
                            value={value}
                            onChangeText={onChangeText}
                            autoFocus
                            returnKeyType="done"
                            onSubmitEditing={onConfirm}
                        />
                    </Input>
                </ModalBody>
                <ModalFooter className="border-t border-gray-700 pt-4">
                    <VStack className="w-full" space="md">
                        <Button
                            onPress={onConfirm}
                            disabled={isAdding || !value.trim()}
                            className="w-full"
                        >
                            <ButtonText>{isAdding ? t('configPanel.adding') : t('configPanel.addTopic')}</ButtonText>
                        </Button>
                        <Button
                            variant="outline"
                            action="secondary"
                            onPress={onCancel}
                            disabled={isAdding}
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

export default AddTopicModal;
