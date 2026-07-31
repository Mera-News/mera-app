import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Input, InputField } from '@/components/ui/input';
import {
    Modal,
    ModalBackdrop,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
} from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = '#EDA77E';

interface AddPhraseModalProps {
    readonly isOpen: boolean;
    readonly onClose: () => void;
    /** Resolves once the filter is stored; the modal stays up while it runs. */
    readonly onSubmit: (phrase: string, hard: boolean) => Promise<void>;
}

/**
 * Create a filter by hand. Keyword-only, deliberately: every structured kind
 * matches by exact normalized equality against one article field, so a
 * free-typed category or place would look active and never fire. Those kinds
 * are minted from real article context instead (chat, the feedback tree, the
 * digest) — the copy says so, warmly, rather than as a warning.
 */
const AddPhraseModal: React.FC<AddPhraseModalProps> = ({ isOpen, onClose, onSubmit }) => {
    const { t } = useTranslation();
    const [phrase, setPhrase] = useState('');
    const [hard, setHard] = useState(false);
    const [saving, setSaving] = useState(false);

    // Reset between openings — a half-typed phrase from a cancelled attempt
    // reappearing is confusing, not helpful.
    useEffect(() => {
        if (isOpen) {
            setPhrase('');
            setHard(false);
            setSaving(false);
        }
    }, [isOpen]);

    const handleSubmit = async () => {
        const trimmed = phrase.trim();
        if (!trimmed || saving) return;
        setSaving(true);
        try {
            await onSubmit(trimmed, hard);
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="md">
            <ModalBackdrop />
            <ModalContent>
                <ModalHeader className="pb-3">
                    <HStack className="items-center" space="xs">
                        <MaterialIcons name="visibility-off" size={18} color={ACCENT} />
                        <Text className="text-base font-semibold text-white">
                            {t('notInterested.addPhraseTitle')}
                        </Text>
                    </HStack>
                </ModalHeader>
                <ModalBody className="py-4">
                    <Box testID="add-phrase-modal">
                        <Text className="text-gray-300 text-sm leading-relaxed mb-4">
                            {t('notInterested.addPhraseBody')}
                        </Text>
                        {/* testID lives on the wrapper: gluestack's InputField is an
                            accessibility container and swallows it. */}
                        <Box testID="add-phrase-input-wrapper" className="mb-4">
                            <Input variant="outline" size="md">
                                <InputField
                                    value={phrase}
                                    onChangeText={setPhrase}
                                    placeholder={t('notInterested.addPhrasePlaceholder')}
                                    autoFocus
                                    returnKeyType="done"
                                    onSubmitEditing={handleSubmit}
                                />
                            </Input>
                        </Box>
                        <HStack className="items-center justify-between" space="md">
                            <VStack className="flex-1 mr-2">
                                <Text size="sm" className="text-white">
                                    {t('notInterested.addPhraseHardLabel')}
                                </Text>
                                <Text size="xs" className="text-gray-500 mt-0.5">
                                    {t('notInterested.addPhraseHardHint')}
                                </Text>
                            </VStack>
                            <Box testID="add-phrase-hard-switch">
                                <Switch
                                    value={hard}
                                    onToggle={() => setHard((v) => !v)}
                                    size="md"
                                />
                            </Box>
                        </HStack>
                    </Box>
                </ModalBody>
                <ModalFooter className="border-t border-gray-700 pt-4">
                    <VStack className="w-full" space="md">
                        <Button
                            testID="add-phrase-submit"
                            onPress={handleSubmit}
                            isDisabled={!phrase.trim() || saving}
                            className="w-full"
                        >
                            {saving ? (
                                <Spinner size="small" />
                            ) : (
                                <ButtonText>{t('notInterested.addPhraseSubmit')}</ButtonText>
                            )}
                        </Button>
                        <Button
                            testID="add-phrase-cancel"
                            variant="outline"
                            action="secondary"
                            onPress={onClose}
                            isDisabled={saving}
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

export default AddPhraseModal;
