import AiDisclosureCaption from '@/components/custom/AiDisclosureCaption';
import RelevanceChip from '@/components/custom/RelevanceChip';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { useMatchedFacts, useNoteInk } from '@/components/custom/cards/FactChips';
import { factsLine } from '@/lib/algorithms/facts-line';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { MOTION } from '@/lib/motion';
import { primaryStatement } from '@/lib/stores/fact-rows-selector';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { noteBoxState, type NoteBoxState, type ReasonNotePendingMode } from '@/components/custom/cards/note-pending-mode';
import { TYPE_SCALE } from '@/lib/algorithms/scale';
import { scaledTypeStyle, useTextScale } from '@/lib/typography/TextScaleContext';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useMotionAllowed } from '@/lib/motion-gate';

export { notePendingMode, type ReasonNotePendingMode } from '@/components/custom/cards/note-pending-mode';

interface ReasonNoteProps {
    /** Persisted relevance, drives the priority chip. */
    relevance: number;
    /** Mera's note. Empty while it is still pending. */
    reason: string;
    testID?: string;
    /** The note as displayed (it may be translated), for the card's spoken label. */
    onNoteDisplayChange?: (text: string) => void;
    /** The pending state (see {@link notePendingMode}). Applies only while
     *  `reason` is empty. */
    pendingMode?: ReasonNotePendingMode;
    /** The `held` line (why and when Mera writes the note), resolved once
     *  by the host's list from its one `useReadHeld`. */
    heldLine?: string;
    /** The host speaks the pending state in its own label (the Feed card's
     *  root), so the slot is hidden from VoiceOver and TalkBack. */
    pendingSpokenByHost?: boolean;
    /** The suggestion's `userTopicIds`: the facts the waiting line names. */
    topicIds?: string[] | null;
    /** Clamp the note to this many lines (the card; the detail shows it all). */
    maxNoteLines?: number;
    /** Size the box up front for this many note lines, in EVERY state, so a
     *  note landing under the reader never changes the card's height. Omitted:
     *  natural height (the detail screen). */
    reserveNoteLines?: number;
}

/** Space above and below the badge row. */
const BADGE_ROW_PADDING = 6;
/** The priority chip's height at text scale 1 (11/16 text + 4pt padding). */
const CHIP_HEIGHT = 24;
/** FinalRead #3: 250 ms per word, 40 ms apart, the whole reveal under a
 *  second (a long note tightens the stagger). */
const NOTE_REVEAL = { ...MOTION.noteReveal, total: 1000 } as const;
/** Scripts written without spaces: their note fades in whole. */
const NO_SPACE_SCRIPT = /[฀-໿က-႟ក-៿぀-ヿ㐀-鿿가-힯]/;

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

/** The note's words rising in one by one over the laid-out (hidden) note. */
const WordReveal: React.FC<{ text: string; maxHeight?: number }> = ({ text, maxHeight }) => {
    const note = useNoteInk();
    const words = text.split(' ').filter(Boolean);
    const stagger = Math.min(NOTE_REVEAL.stagger, (NOTE_REVEAL.total - NOTE_REVEAL.word) / Math.max(1, words.length));
    return (
        <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ position: 'absolute', top: 0, left: 0, right: 0, maxHeight, overflow: 'hidden', flexDirection: 'row', flexWrap: 'wrap' }}
        >
            {words.map((w, i) => (
                <Animated.View
                    key={`${i}:${w}`}
                    entering={FadeInUp.duration(NOTE_REVEAL.word)
                        .delay(Math.round(i * stagger))
                        .withInitialValues({ opacity: 0, transform: [{ translateY: 2 }] })}
                >
                    <Text size={NOTE_TOKEN} bold style={{ color: note.ink }}>
                        {`${w} `}
                    </Text>
                </Animated.View>
            ))}
        </View>
    );
};

/**
 * The AI note block, ONE layout for the Feed card and the detail screen.
 *
 *   writing   [priority] .................. Matches your facts
 *             Fact One · Fact Two
 *             Please wait while Mera writes the reason.
 *   no note   [priority] .................. Matches your facts   (Skip notes)
 *             Fact One · Fact Two
 *   note      [priority] ..................... [✦ AI-generated]
 *             Mera's note, full width.
 *   held      [priority] ...... Today's reading is used up, so Mera will
 *                               write this note after 01:00 tomorrow.
 *
 * The chip shows as soon as the row has a relevance, in every state (owner,
 * 2026-10-20: a score that exists is shown, it does not wait for the note).
 * When the note lands in a MOUNTED box (never on mount, never on a remount or
 * a translation swap), the wait lifts away and the words rise in one by one;
 * Reduce Motion, Lite, a translated app and scripts without spaces get the
 * whole note fading in instead.
 */
/**
 * No AI note: the relevance chip with a caption saying why (writing, paused for
 * the day, Skip notes on, or the note failed), then the matched facts as one
 * Title Case line joined by middle dots (wraps, never cut). Paused also says
 * when the note will come. Only an AI note carries the AI-generated caption.
 */
const FactsNote: React.FC<{
    relevance: number;
    topicIds?: string[] | null;
    state: NoteBoxState;
    heldLine?: string;
    testID?: string;
    hideSlot: object | null;
}> = ({ relevance, topicIds, state, heldLine, testID, hideSlot }) => {
    const { t } = useTranslation();
    const note = useNoteInk();
    const line = factsLine(useMatchedFacts(topicIds).map((f) => primaryStatement(f.statement)));
    return (
        <Box testID={testID} className="rounded-lg px-3 pb-3" style={{ backgroundColor: note.box, paddingTop: 12 - BADGE_ROW_PADDING }}>
            <HStack
                className="items-center justify-between"
                space="md"
                style={{ paddingVertical: BADGE_ROW_PADDING }}
                testID={testID ? `${testID}-badge-row` : undefined}
            >
                <RelevanceChip relevance={relevance} />
                <Animated.View exiting={state === 'writing' ? FadeOutUp.duration(180) : undefined} style={{ flexShrink: 1 }} {...hideSlot}>
                    <Text
                        size="2xs"
                        style={{ color: note.ai, textAlign: 'right' }}
                        testID={testID ? `${testID}-${state}` : undefined}
                    >
                        {t(`feed.noteState.${state}`)}
                    </Text>
                </Animated.View>
            </HStack>
            {line ? (
                <Text size={NOTE_TOKEN} bold style={{ color: note.ink, marginTop: 4 }} testID={testID ? `${testID}-facts` : undefined}>
                    {line}
                </Text>
            ) : null}
            {state === 'paused' && heldLine ? (
                <Text size={NOTE_TOKEN} style={{ color: note.ink, marginTop: 4 }} testID={testID ? `${testID}-held` : undefined}>
                    {heldLine}
                </Text>
            ) : null}
        </Box>
    );
};

const ReasonNote: React.FC<ReasonNoteProps> = ({
    relevance,
    reason,
    testID,
    onNoteDisplayChange,
    pendingMode,
    heldLine,
    pendingSpokenByHost = false,
    topicIds,
    maxNoteLines,
    reserveNoteLines,
}) => {
    const { t, i18n } = useTranslation();
    const lineHeight = useNoteLineHeight();
    const motion = useMotionAllowed();
    const note = useNoteInk();
    const pending = !reason ? pendingMode : undefined;
    const skipNotes = useMeraProtocolStore((st) => st.skipNotes);

    // An in-mount transition only: a box first drawn with its note never
    // animates (virtualised remounts, a translation swap).
    const [sawWriting, setSawWriting] = useState(pending === 'writing');
    if (pending === 'writing' && !sawWriting) setSawWriting(true);
    const revealing = !!reason && sawWriting;
    const [revealDone, setRevealDone] = useState(false);
    const wordByWord =
        revealing &&
        !revealDone &&
        motion &&
        // The note is written in English; a translated app fades it whole.
        (i18n.language ?? 'en').startsWith('en') &&
        !NO_SPACE_SCRIPT.test(reason);
    useEffect(() => {
        if (!wordByWord) return;
        const timer = setTimeout(() => setRevealDone(true), NOTE_REVEAL.total + 50);
        return () => clearTimeout(timer);
    }, [wordByWord]);

    // Fixed box on the Feed: badge row + the reserved lines, scaled with the
    // text, so writing, note and held all draw the same height.
    const chipHeight = CHIP_HEIGHT * (lineHeight / TYPE_SCALE[NOTE_TOKEN].lineHeight);
    const boxHeight = reserveNoteLines
        ? 12 - BADGE_ROW_PADDING + 2 * BADGE_ROW_PADDING + chipHeight + 4 + reserveNoteLines * lineHeight + 12
        : undefined;
    const hideSlot = pendingSpokenByHost
        ? {
            accessible: false,
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants' as const,
        }
        : null;

    const boxStyle = {
        backgroundColor: note.box,
        paddingTop: 12 - BADGE_ROW_PADDING,
        ...(boxHeight ? { height: boxHeight, overflow: 'hidden' as const } : null),
    };

    // No AI note: the facts that found it, captioned with why.
    if (!reason) {
        return (
            <FactsNote
                relevance={relevance}
                topicIds={topicIds}
                state={noteBoxState(pending, skipNotes)}
                heldLine={heldLine}
                testID={testID}
                hideSlot={hideSlot}
            />
        );
    }

    const noteStyle = { color: note.ink, ...(wordByWord ? { opacity: 0 } : null) };
    return (
        <Box testID={testID} className="rounded-lg px-3 pb-3" style={boxStyle}>
            <HStack
                className="items-center justify-between"
                space="md"
                style={{ paddingVertical: BADGE_ROW_PADDING }}
                testID={testID ? `${testID}-badge-row` : undefined}
            >
                <RelevanceChip relevance={relevance} />
                <AiDisclosureCaption variant="compact" text={t('aiDisclosure.short')} color={note.ai} />
            </HStack>
            {reason ? (
                <Animated.View
                    style={{ marginTop: 4 }}
                    entering={revealing && !wordByWord ? FadeIn.duration(NOTE_REVEAL.word) : undefined}
                    testID={testID ? `${testID}-text` : undefined}
                >
                    <TranslatableDynamic
                        text={reason}
                        size={NOTE_TOKEN}
                        bold
                        className="text-left"
                        numberOfLines={maxNoteLines}
                        style={noteStyle}
                        onDisplayChange={onNoteDisplayChange ? (d) => onNoteDisplayChange(d.displayedText) : undefined}
                    />
                    {wordByWord ? (
                        <WordReveal text={reason} maxHeight={maxNoteLines ? maxNoteLines * lineHeight : undefined} />
                    ) : null}
                </Animated.View>
            ) : null}
        </Box>
    );
};

export default ReasonNote;
