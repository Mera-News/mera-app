// RequestUnblockModal — lets a blocked user submit an unblock request with a
// feedback note. On submit it pulls the current conversation transcript and
// sends it to the server for manual review (staff may terminate the account if
// the violation is severe). Presentational + local state only; the actual
// mutation goes through AccountService.

import { Button, ButtonText } from '@/components/ui/button';
import { Input, InputField } from '@/components/ui/input';
import {
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@/components/ui/modal';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
  AccountService,
  type ChatMessageInput,
} from '@/lib/account-service';
import { fetchMessagesForConversation } from '@/lib/database/services/conversation-service';
import logger from '@/lib/logger';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface RequestUnblockModalProps {
  isOpen: boolean;
  onClose: () => void;
  conversationId: string;
  userId: string;
  /** Called when a request is created OR already exists — parent flips to pending. */
  onSubmitted: () => void;
}

export default function RequestUnblockModal({
  isOpen,
  onClose,
  conversationId,
  userId,
  onSubmitted,
}: RequestUnblockModalProps) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const resetAndClose = () => {
    setFeedback('');
    setIsSubmitting(false);
    setSubmitted(false);
    setErrorMessage(null);
    onClose();
  };

  const handleSubmit = async () => {
    const trimmed = feedback.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const transcript = await fetchMessagesForConversation(conversationId);
      const chatHistory: ChatMessageInput[] = transcript.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: new Date(m.createdAt).toISOString(),
      }));

      await AccountService.requestUnblock({
        userId,
        feedback: trimmed,
        chatHistory,
      });

      setSubmitted(true);
      onSubmitted();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The server rejects a second request while one is already PENDING. Treat
      // that as a soft, expected outcome: surface it plainly and flip the parent
      // into its pending state rather than showing a hard error.
      if (/pending/i.test(message)) {
        setSubmitted(true);
        setErrorMessage(t('floatingChat.requestUnblock.alreadyPending'));
        onSubmitted();
      } else {
        logger.captureException(error, {
          tags: { component: 'RequestUnblockModal', method: 'handleSubmit' },
          extra: { userId },
        });
        setErrorMessage(t('floatingChat.requestUnblock.error'));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={resetAndClose} size="md">
      <ModalBackdrop />
      <ModalContent className="bg-gray-900 border border-gray-700">
        <ModalHeader className="border-gray-700 pb-4">
          <Text className="text-xl font-semibold text-red-400">
            {t('floatingChat.requestUnblock.modalTitle')}
          </Text>
        </ModalHeader>
        <ModalBody className="py-4">
          {submitted ? (
            <Text className="text-gray-300 text-base leading-relaxed">
              {errorMessage ?? t('floatingChat.requestUnblock.submittedConfirmation')}
            </Text>
          ) : (
            <VStack space="md">
              <Text className="text-red-300 text-sm font-medium leading-relaxed">
                {t('floatingChat.requestUnblock.warningText')}
              </Text>
              <Input className="min-h-24">
                <InputField
                  placeholder={t('floatingChat.requestUnblock.feedbackPlaceholder')}
                  value={feedback}
                  onChangeText={setFeedback}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                  autoFocus
                  editable={!isSubmitting}
                />
              </Input>
              {errorMessage && (
                <Text className="text-red-400 text-sm">{errorMessage}</Text>
              )}
            </VStack>
          )}
        </ModalBody>
        <ModalFooter className="border-t border-gray-700 pt-4">
          <VStack className="w-full" space="md">
            {submitted ? (
              <Button onPress={resetAndClose} className="w-full">
                <ButtonText>{t('floatingChat.close')}</ButtonText>
              </Button>
            ) : (
              <>
                <Button
                  action="negative"
                  onPress={handleSubmit}
                  disabled={isSubmitting || !feedback.trim()}
                  className="w-full"
                >
                  <ButtonText>
                    {isSubmitting
                      ? t('floatingChat.requestUnblock.submitting')
                      : t('floatingChat.requestUnblock.submit')}
                  </ButtonText>
                </Button>
                <Button
                  variant="outline"
                  action="secondary"
                  onPress={resetAndClose}
                  disabled={isSubmitting}
                  className="w-full"
                >
                  <ButtonText>{t('common.cancel')}</ButtonText>
                </Button>
              </>
            )}
          </VStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
