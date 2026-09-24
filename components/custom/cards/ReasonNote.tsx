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
    testID?: string;
}

/** Space above and below the badge row. */
const BADGE_ROW_PADDING = 6;

/**
 * The AI note block, ONE layout for the Feed card and the detail screen.
 *
 * A badge row, then the note at full width, left-aligned:
 *
 *   [importance badge] ................ [✦ AI-generated note]
 *   Mera's note, full width.
 *
 * The disclosure sits at the right end of the badge row (owner review), not on
 * a line of its own under the note, and it renders only when there IS a note
 * to disclose. While the note is pending, the placeholder takes the disclosure's
 * place beside the badge, so the box does not jump when the note lands.
 */
const ReasonNote: React.FC<ReasonNoteProps> = ({ relevance, reason, pendingSinceMs, testID }) => {
    const { t } = useTranslation();
    return (
        <Box
            testID={testID}
            className="rounded-lg px-3 pb-3"
            style={{ backgroundColor: reasonBoxColors.backgroundColor, paddingTop: 12 - BADGE_ROW_PADDING }}
        >
            <HStack
                className="items-center justify-between"
                space="md"
                style={{ paddingVertical: BADGE_ROW_PADDING }}
                testID={testID ? `${testID}-badge-row` : undefined}
            >
                <RelevanceChip relevance={relevance} />
                {reason ? (
                    <AiDisclosureCaption color={aiDisclosureColor} align="right" />
                ) : (
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
                <Box className="mt-1" testID={testID ? `${testID}-text` : undefined}>
                    <TranslatableDynamic
                        text={reason}
                        size="sm"
                        bold
                        className="text-left"
                        style={{ color: reasonBoxColors.textColor }}
                    />
                </Box>
            ) : null}
        </Box>
    );
};

export default ReasonNote;
