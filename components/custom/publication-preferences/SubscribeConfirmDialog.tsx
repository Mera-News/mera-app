import { Button, ButtonText } from '@/components/ui/button';
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
import React from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  readonly publisherName: string | null;
  readonly onYes: () => void;
  readonly onNo: () => void;
}

/**
 * "Did you subscribe to X?" after a trip to the publisher's subscribe page.
 *
 * A real dialog, not a toast or a banner. It asks a question whose answer is
 * written to durable state, so it has to be answerable and dismissable rather
 * than something that can scroll away unnoticed.
 *
 * Three things are deliberate:
 *  - The publisher NAME is in the title, so a screen reader announces which
 *    publisher is being asked about rather than "Did you subscribe?".
 *  - `onNo` is wired to BOTH the No button and `onClose`, so a swipe-down or a
 *    hardware back press counts as No. A dismissal is not an unanswered
 *    question: the user was asked and chose not to say yes, and treating that
 *    as "ask again later" is how a prompt becomes nagging.
 *  - No is one tap and carries no confirmation of its own.
 */
const SubscribeConfirmDialog: React.FC<Props> = ({ publisherName, onYes, onNo }) => {
  const { t } = useTranslation();
  if (!publisherName) return null;

  return (
    <Modal isOpen onClose={onNo} size="sm">
      <ModalBackdrop />
      <ModalContent
        // Keeps the screen reader inside the dialog while it is open, so the
        // list behind it is not reachable by swipe.
        accessibilityViewIsModal
        accessibilityLabel={t('subscriptions.confirmTitle', { publisher: publisherName })}
      >
        <ModalHeader className="border-gray-700 pb-4">
          <Text className="text-xl font-semibold text-white">
            {t('subscriptions.confirmTitle', { publisher: publisherName })}
          </Text>
        </ModalHeader>
        <ModalBody className="py-6">
          <Text className="text-gray-300 text-base leading-relaxed">
            {t('subscriptions.confirmBody', { publisher: publisherName })}
          </Text>
        </ModalBody>
        <ModalFooter className="border-t border-gray-700 pt-4">
          <VStack className="w-full" space="md">
            <Button onPress={onYes} className="w-full">
              <ButtonText>{t('subscriptions.confirmYes')}</ButtonText>
            </Button>
            <Button variant="outline" action="secondary" onPress={onNo} className="w-full">
              <ButtonText>{t('subscriptions.confirmNo')}</ButtonText>
            </Button>
          </VStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};

export default SubscribeConfirmDialog;
