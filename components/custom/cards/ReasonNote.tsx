import AiDisclosureCaption from '@/components/custom/AiDisclosureCaption';
import RelevanceChip from '@/components/custom/RelevanceChip';
import StreamingIndicator from '@/components/custom/chat/StreamingIndicator';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { aiDisclosureColor, reasonBoxColors } from '@/lib/relevance-utils';
import React from 'react';
import { useTranslation } from 'react-i18next';

export interface ReasonNoteProps {
    /** Persisted relevance, drives the priority chip. */
    relevance: number;
    /** Mera's note. Empty while it is still pending. */
    reason: string;
    /** When the note started waiting (see `pendingSinceMs`), for the cap. */
    pendingSinceMs: number | null;
    /** Rendered under the note: the fact chip (A2). */
    below?: React.ReactNode;
    testID?: string;
}

/**
 * The AI note block, ONE layout for the Feed card and the detail screen (F24).
 *
 * The chip sits on its own row and the note runs LEFT-ALIGNED at full width
 * beneath it. It used to be a chip plus a right-aligned, ragged column beside
 * it, and the detail screen had its own copy of the block with a different
 * layout again (chip and disclosure in a 150pt column). The note is the
 * product's value; it gets the width.
 *
 * While the note is pending, the placeholder sits beside the chip, where the
 * note will not be, so the box does not jump when the note lands.
 */
const ReasonNote: React.FC<ReasonNoteProps> = ({ relevance, reason, pendingSinceMs, below, testID }) => {
    const { t } = useTranslation();
    return (
        <Box
            testID={testID}
            className="rounded-lg p-3"
            style={{ backgroundColor: reasonBoxColors.backgroundColor }}
        >
            <HStack className="items-center" space="md">
                <RelevanceChip relevance={relevance} />
                {reason ? null : (
                    <Box className="flex-1 items-start">
                        <StreamingIndicator
                            compact
                            color={reasonBoxColors.textColor}
                            // Gives up after REASON_PENDING_CAP_MS: a dead scoring
                            // bundle leaves the row pending for good.
                            pendingSinceMs={pendingSinceMs}
                            terminalText={t('feed.reasonUnavailable')}
                        />
                    </Box>
                )}
            </HStack>
            {reason ? (
                <Box className="mt-2" testID={testID ? `${testID}-text` : undefined}>
                    <TranslatableDynamic
                        text={reason}
                        size="sm"
                        bold
                        className="text-left"
                        style={{ color: reasonBoxColors.textColor }}
                    />
                </Box>
            ) : null}
            {below}
            {/* Gated on `reason`: the disclosure's whole contract is that it
                renders when there IS AI-generated text to disclose, never beside
                the pending placeholder. */}
            {reason ? (
                <AiDisclosureCaption color={aiDisclosureColor} align="left" className="mt-2" />
            ) : null}
        </Box>
    );
};

export default ReasonNote;
