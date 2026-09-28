import AiDisclosureCaption from '@/components/custom/AiDisclosureCaption';
import RelevanceChip from '@/components/custom/RelevanceChip';
import StreamingIndicator from '@/components/custom/chat/StreamingIndicator';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { aiDisclosureColor, reasonBoxColors } from '@/lib/relevance-utils';
import { TYPE_SCALE } from '@/lib/typography/scale';
import { scaledTypeStyle, useTextScale } from '@/lib/typography/TextScaleContext';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';

/**
 * The Feed card's state for a note that is not there yet.
 *  - `writing`: the row's reasons are in flight; "Writing a note" + the dots.
 *  - `not-yet`: nothing is in flight for it (or the backstop passed); a static
 *    line, so the box is never empty and never claims work that is not
 *    happening.
 */
export type ReasonNotePendingMode = 'writing' | 'not-yet';

export interface ReasonNoteProps {
    /** Persisted relevance, drives the priority chip. */
    relevance: number;
    /** Mera's note. Empty while it is still pending. */
    reason: string;
    /** When the note started waiting (see `pendingSinceMs`), for the cap. */
    pendingSinceMs: number | null;
    testID?: string;
    /** The note exactly as displayed (it may be translated), for the card's
     *  explicit spoken label. */
    onNoteDisplayChange?: (text: string) => void;
    /** The Feed's pending states (see {@link ReasonNotePendingMode}). Applies
     *  only while `reason` is empty. Omitted (the detail screen): the legacy
     *  placeholder beside the badge, with its 90s cap. */
    pendingMode?: ReasonNotePendingMode;
    /** Minimum height of the note area, in lines of the note's own type token,
     *  in EVERY state, so the card keeps its height when the note lands under
     *  the reader. Omitted: no floor (the detail screen). */
    reserveNoteLines?: number;
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
/** The note's type token; the reserved height is counted in its lines. */
const NOTE_TOKEN = 'sm' as const;

/** One line of the note, in points, as it will actually render: the token's
 *  line height at the in-app text scale, times the OS font scale (RN scales
 *  `lineHeight` with it when font scaling is allowed). */
function useNoteLineHeight(): number {
    const scale = useTextScale();
    const { fontScale } = useWindowDimensions();
    const lineHeight = scaledTypeStyle(NOTE_TOKEN, scale)?.lineHeight ?? TYPE_SCALE[NOTE_TOKEN].lineHeight;
    return lineHeight * (fontScale || 1);
}

const ReasonNote: React.FC<ReasonNoteProps> = ({
    relevance,
    reason,
    pendingSinceMs,
    testID,
    onNoteDisplayChange,
    pendingMode,
    reserveNoteLines,
}) => {
    const { t } = useTranslation();
    const lineHeight = useNoteLineHeight();
    const noteMinHeight = reserveNoteLines ? reserveNoteLines * lineHeight : undefined;
    // Feed pending states draw in the NOTE AREA, not beside the badge: the
    // disclosure appears only once a real note exists (owner), and the area
    // keeps one height across writing, not-yet and the note itself.
    const feedPending = !reason && pendingMode !== undefined;
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
                ) : feedPending ? null : (
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
            {feedPending ? (
                <Box
                    className="mt-1"
                    style={noteMinHeight ? { minHeight: noteMinHeight } : undefined}
                    testID={testID ? `${testID}-pending` : undefined}
                >
                    {pendingMode === 'writing' ? (
                        // Hidden from VoiceOver and TalkBack: the card root speaks
                        // "note being written" in its own label instead.
                        <View
                            accessible={false}
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                            testID={testID ? `${testID}-writing` : undefined}
                        >
                            <StreamingIndicator
                                compact
                                color={reasonBoxColors.textColor}
                                label={t('feed.reasonWriting')}
                            />
                        </View>
                    ) : (
                        <Text
                            size={NOTE_TOKEN}
                            style={{ color: reasonBoxColors.textColor }}
                            testID={testID ? `${testID}-not-yet` : undefined}
                        >
                            {t('feed.reasonNotYet')}
                        </Text>
                    )}
                </Box>
            ) : null}
            {reason ? (
                <Box
                    className="mt-1"
                    style={noteMinHeight ? { minHeight: noteMinHeight } : undefined}
                    testID={testID ? `${testID}-text` : undefined}
                >
                    <TranslatableDynamic
                        text={reason}
                        size="sm"
                        bold
                        className="text-left"
                        style={{ color: reasonBoxColors.textColor }}
                        onDisplayChange={onNoteDisplayChange ? (d) => onNoteDisplayChange(d.displayedText) : undefined}
                    />
                </Box>
            ) : null}
        </Box>
    );
};

export default ReasonNote;
