import AiDisclosureCaption from '@/components/custom/AiDisclosureCaption';
import RelevanceChip from '@/components/custom/RelevanceChip';
import StreamingIndicator from '@/components/custom/chat/StreamingIndicator';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { aiDisclosureColor, reasonBoxColors } from '@/lib/relevance-utils';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { TYPE_SCALE } from '@/lib/typography/scale';
import { scaledTypeStyle, useTextScale } from '@/lib/typography/TextScaleContext';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';

/**
 * The state of a note that is not there yet, shared by the Feed card and the
 * detail screen so the two can never disagree:
 *  - `writing`: the row's reasons are in flight; "Writing a note" + the dots.
 *  - `not-yet`: nothing is in flight for it (or the backstop passed); a static
 *    line, so the box is never empty and never claims work that is not
 *    happening.
 */
export type ReasonNotePendingMode = 'writing' | 'not-yet';

/**
 * The ONE rule for which pending state a scored row shows. Undefined when the
 * row is unscored, has its note, or is `complete` (a complete row with no note
 * shows its fact chips instead). `reasonWriting` is `useReasonWriting(row._id)`:
 * the live in-flight set, never a timer.
 */
export function notePendingMode(
    s: Pick<ForYouSuggestion, 'status' | 'reason'>,
    reasonWriting: boolean,
): ReasonNotePendingMode | undefined {
    const status = s.status;
    if (!status || status === ArticleSuggestionStatus.Unscored) return undefined;
    if (s.reason || status === ArticleSuggestionStatus.Complete) return undefined;
    return status === ArticleSuggestionStatus.ReasonPending && reasonWriting ? 'writing' : 'not-yet';
}

export interface ReasonNoteProps {
    /** Persisted relevance, drives the priority chip. */
    relevance: number;
    /** Mera's note. Empty while it is still pending. */
    reason: string;
    testID?: string;
    /** The note exactly as displayed (it may be translated), for the card's
     *  explicit spoken label. */
    onNoteDisplayChange?: (text: string) => void;
    /** The pending state (see {@link notePendingMode}). Applies only while
     *  `reason` is empty. */
    pendingMode?: ReasonNotePendingMode;
    /** The host speaks the pending state in its own label (the Feed card's
     *  root), so the slot is hidden from VoiceOver and TalkBack. */
    pendingSpokenByHost?: boolean;
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
 * to disclose. While the note is pending, the pending line takes the
 * disclosure's place, right-aligned, on every surface.
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
    testID,
    onNoteDisplayChange,
    pendingMode,
    pendingSpokenByHost = false,
    reserveNoteLines,
}) => {
    const { t } = useTranslation();
    const lineHeight = useNoteLineHeight();
    const noteMinHeight = reserveNoteLines ? reserveNoteLines * lineHeight : undefined;
    const pending = !reason ? pendingMode : undefined;
    const pendingEl = pending === 'writing' ? (
        <StreamingIndicator compact color={reasonBoxColors.textColor} label={t('feed.reasonWriting')} />
    ) : pending === 'not-yet' ? (
        <Text size={NOTE_TOKEN} style={{ color: reasonBoxColors.textColor, textAlign: 'right' }}>
            {t('feed.reasonNotYet')}
        </Text>
    ) : null;
    const pendingSlot = pendingEl ? (
        <View
            style={{ flex: 1, alignItems: 'flex-end', justifyContent: 'center' }}
            testID={testID ? `${testID}-${pending}` : undefined}
            {...(pendingSpokenByHost
                ? {
                    accessible: false,
                    accessibilityElementsHidden: true,
                    importantForAccessibility: 'no-hide-descendants' as const,
                }
                : null)}
        >
            {pendingEl}
        </View>
    ) : null;
    // Pending inside a reserved height (the Feed): the reserve sits in the
    // chip's column, so the pending line's column spans the whole reserved box
    // and centres in it. A spacer UNDER the row could only centre the line in
    // the chip's row, leaving it pinned to the top of an empty box. Same total
    // height as the note state, and the chip stays where that state draws it.
    if (!reason && noteMinHeight) {
        return (
            <Box
                testID={testID}
                className="rounded-lg px-3 pb-3"
                style={{ backgroundColor: reasonBoxColors.backgroundColor, paddingTop: 12 - BADGE_ROW_PADDING }}
            >
                <HStack
                    className="justify-between"
                    space="md"
                    style={{ paddingVertical: BADGE_ROW_PADDING, alignItems: 'stretch' }}
                    testID={testID ? `${testID}-badge-row` : undefined}
                >
                    <View style={{ alignItems: 'flex-start' }}>
                        <RelevanceChip relevance={relevance} />
                        <Box className="mt-1" style={{ minHeight: noteMinHeight }} testID={testID ? `${testID}-pending` : undefined} />
                    </View>
                    {pendingSlot}
                </HStack>
            </Box>
        );
    }
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
                {reason ? <AiDisclosureCaption color={aiDisclosureColor} align="right" /> : pendingSlot}
            </HStack>
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
