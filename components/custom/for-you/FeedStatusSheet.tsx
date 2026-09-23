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
import React from 'react';
import { useTranslation } from 'react-i18next';
import FeedStatusDetails from './FeedStatusDetails';

interface FeedStatusSheetProps {
    readonly isOpen: boolean;
    readonly onClose: () => void;
    /** Human relative label for the last finished processing run, or null. */
    readonly lastProcessedLabel: string | null;
}

/**
 * The feed-status detail sheet (Gluestack Modal), opened from the header status
 * line ("updated X ago"). It wraps the shared {@link FeedStatusDetails} body —
 * the same surface the FeedStatusShimmer expand accordion renders inline — so the
 * copy + selectors live in exactly one place.
 */
const FeedStatusSheet: React.FC<FeedStatusSheetProps> = ({
    isOpen,
    onClose,
    lastProcessedLabel,
}) => {
    const { t } = useTranslation();

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="md">
            <ModalBackdrop />
            <ModalContent>
                <ModalHeader>
                    <Heading size="xl" className="text-white">
                        {t('feedStatus.title')}
                    </Heading>
                </ModalHeader>
                <ModalBody>
                    <FeedStatusDetails
                        lastProcessedLabel={lastProcessedLabel}
                        // The body's daily-limit "Manage" pill navigates; this
                        // modal must come down first or the pushed screen lands
                        // behind the backdrop.
                        onBeforeNavigate={onClose}
                    />
                </ModalBody>
                <ModalFooter>
                    {/* Neutral, not the primary accent: closing is not the
                        action this sheet exists for, and a full-width orange
                        slab read as one. */}
                    <Button
                        variant="outline"
                        className="flex-1 border-white/30"
                        onPress={onClose}
                        testID="feed-status-sheet-close"
                    >
                        <ButtonText className="text-white">{t('feedStatus.close')}</ButtonText>
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
};

export default FeedStatusSheet;
