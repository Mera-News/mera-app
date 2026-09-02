import { Button, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import {
    Modal,
    ModalBackdrop,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
} from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { presentFreeTierPaywall } from '@/lib/subscription/present-free-tier-paywall';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export interface FreeTierExplainerSheetProps {
    readonly isOpen: boolean;
    readonly onClose: () => void;
}

/**
 * Why only two interests are live, in one tap.
 *
 * ## Why a tap does not open the paywall directly
 *
 * It used to be tempting to send a paused row straight to
 * `presentFreeTierPaywall`, which reads as "one tap to upgrade". But that
 * function awaits `ensureEmailBeforeCheckout()` first, and `userNeedsEmail` is
 * true for anonymous and `@anon.mera.news` accounts, which is most free users.
 * So the one tap actually opened an EMAIL FORM, in answer to a question the
 * user had not asked yet. This sheet answers the question the tap really asks,
 * and the email step stays attached to "See plans", where a user expects it.
 *
 * ## Why the copy names the rule
 *
 * Nothing in the app said WHY these two facts and not two others. A badge can
 * mark a state but cannot explain one, and "the two interests you added first"
 * is the entire rule in six words.
 *
 * Deliberately imports no `MeraLogo` and no `AbstractGradientBackdrop`: either
 * one drags reanimated into every suite that renders this, and two subscription
 * suites already fail at IMPORT when that happens.
 */
const FreeTierExplainerSheet: React.FC<FreeTierExplainerSheetProps> = ({
    isOpen,
    onClose,
}) => {
    const { t } = useTranslation();

    const handleSeePlans = useCallback(async () => {
        // Close first: the paywall is presented natively over this modal, and
        // leaving it mounted underneath means the user dismisses two things.
        onClose();
        await presentFreeTierPaywall('FreeTierExplainerSheet');
    }, [onClose]);

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="md">
            <ModalBackdrop />
            <ModalContent testID="free-tier-explainer">
                <ModalHeader>
                    <Heading size="md" className="text-white">
                        {t('freeTier.explainerTitle')}
                    </Heading>
                </ModalHeader>
                <ModalBody>
                    <VStack space="sm">
                        <Text size="sm" className="text-gray-300">
                            {t('freeTier.explainerBody')}
                        </Text>
                        <Text size="sm" className="text-gray-300">
                            {t('freeTier.explainerBody2')}
                        </Text>
                    </VStack>
                </ModalBody>
                <ModalFooter>
                    <VStack space="sm" className="w-full">
                        <Button
                            testID="free-tier-explainer-cta"
                            onPress={handleSeePlans}
                            className="bg-primary-500 rounded-full w-full"
                            size="md"
                        >
                            <ButtonText className="text-white">
                                {t('freeTier.seePlans')}
                            </ButtonText>
                        </Button>
                        <Pressable
                            testID="free-tier-explainer-dismiss"
                            onPress={onClose}
                            className="self-center py-2"
                            hitSlop={8}
                        >
                            <Text size="sm" className="text-gray-400">
                                {t('freeTier.explainerDismiss')}
                            </Text>
                        </Pressable>
                    </VStack>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
};

export default FreeTierExplainerSheet;
