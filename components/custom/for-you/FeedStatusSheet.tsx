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
    /** Articles pulled this cycle (store `articleCount`). */
    readonly processedCount: number;
    /** Scored + in-window rows. */
    readonly analysedCount: number;
    /** Analysed rows above the render gate. */
    readonly relevantCount: number;
    /** Decoy clusters dropped by the noise-removal step. */
    readonly noiseRemovedCount: number;
    /** Whether the inject-noise beta setting is on (gates the noise row). */
    readonly injectNoiseEnabled: boolean;
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
    processedCount,
    analysedCount,
    relevantCount,
    noiseRemovedCount,
    injectNoiseEnabled,
    lastProcessedLabel,
}) => {
    const { t } = useTranslation();

    return (
        <Modal isOpen={isOpen} onClose={onClose} size="md">
            <ModalBackdrop />
            <ModalContent className="bg-gray-950 border border-gray-800">
                <ModalHeader>
                    <Heading size="lg" className="text-white">
                        {t('feedStatus.title')}
                    </Heading>
                </ModalHeader>
                <ModalBody>
                    <FeedStatusDetails
                        processedCount={processedCount}
                        analysedCount={analysedCount}
                        relevantCount={relevantCount}
                        noiseRemovedCount={noiseRemovedCount}
                        injectNoiseEnabled={injectNoiseEnabled}
                        lastProcessedLabel={lastProcessedLabel}
                    />
                </ModalBody>
                <ModalFooter>
                    <Button className="flex-1 bg-primary-400" onPress={onClose}>
                        <ButtonText>{t('feedStatus.close')}</ButtonText>
                    </Button>
                </ModalFooter>
            </ModalContent>
        </Modal>
    );
};

export default FeedStatusSheet;
