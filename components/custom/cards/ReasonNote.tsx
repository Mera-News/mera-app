import AiDisclosureCaption from '@/components/custom/AiDisclosureCaption';
import MeraLogo from '@/components/custom/MeraLogo';
import RelevanceChip from '@/components/custom/RelevanceChip';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { useMatchedFacts, useNoteInk } from '@/components/custom/cards/FactChips';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { MOTION, SPRING } from '@/lib/motion';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import { primaryStatement } from '@/lib/stores/fact-rows-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { TYPE_SCALE } from '@/lib/typography/scale';
import { scaledTypeStyle, useTextScale } from '@/lib/typography/TextScaleContext';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeInUp, FadeOutUp, useReducedMotion, ZoomIn } from 'react-native-reanimated';

/**
 * The state of a note that is not there yet, shared by the Feed card and the
 * detail screen so the two can never disagree:
 *  - `writing`: the row's reasons are in flight: the moving Mera logo beside
 *    the fact that found the article and "Please wait while Mera writes the
 *    reason".
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
    /** The note as displayed (it may be translated), for the card's spoken label. */
    onNoteDisplayChange?: (text: string) => void;
    /** The pending state (see {@link notePendingMode}). Applies only while
     *  `reason` is empty. */
    pendingMode?: ReasonNotePendingMode;
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
/** The waiting logo: 0.7x of the 56pt the board first drew. */
const WAIT_LOGO_SIZE = 39;
/** At most this many facts are named in the waiting line. */
const MAX_FACTS_NAMED = 3;
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

/** The facts the waiting line names: deduped titles, at most three. */
function useWaitingFacts(topicIds?: string[] | null): string[] {
    const facts = useMatchedFacts(topicIds);
    return [...new Set(facts.map((f) => primaryStatement(f.statement)))].slice(0, MAX_FACTS_NAMED);
}

/** The waiting line: the fact(s) that found the article, then the wait. */
export const WaitingLine: React.FC<{ facts: string[] }> = ({ facts }) => {
    const { t } = useTranslation();
    const ink = { color: useNoteInk().ink };
    if (facts.length === 1) {
        return (
            <Text size={NOTE_TOKEN} style={ink}>
                {t('feed.noteSuggestedOne', { fact: facts[0] })}
            </Text>
        );
    }
    if (facts.length === 0) {
        return (
            <Text size={NOTE_TOKEN} style={ink}>
                {t('feed.noteWait')}
            </Text>
        );
    }
    return (
        <View>
            <Text size={NOTE_TOKEN} style={ink}>
                {t('feed.noteSuggestedMany')}
            </Text>
            {facts.map((f) => (
                <Text key={f} size={NOTE_TOKEN} style={ink} numberOfLines={1}>
                    {f}
                </Text>
            ))}
            <Text size={NOTE_TOKEN} style={ink}>
                {t('feed.noteWait')}
            </Text>
        </View>
    );
};

/** The waiting line for a suggestion's own facts (queried on mount). */
const WaitingFacts: React.FC<{ topicIds?: string[] | null }> = ({ topicIds }) => (
    <WaitingLine facts={useWaitingFacts(topicIds)} />
);

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
 *   writing   [moving logo]  Suggested for your fact: X. Please wait while
 *                            Mera writes the reason.
 *   note      [priority] ..................... [✦ AI-generated]
 *             Mera's note, full width.
 *   not-yet   [priority] ......... No note for this article yet.
 *
 * No chip while the note is being written (the fact is what the reader learns
 * first). When the note lands in a MOUNTED box (never on mount, never on a
 * remount or a translation swap), the wait lifts away, the chip pops and the
 * words rise in one by one; Reduce Motion, Lite, a translated app and scripts
 * without spaces get the whole note fading in instead.
 */
const ReasonNote: React.FC<ReasonNoteProps> = ({
    relevance,
    reason,
    testID,
    onNoteDisplayChange,
    pendingMode,
    pendingSpokenByHost = false,
    topicIds,
    maxNoteLines,
    reserveNoteLines,
}) => {
    const { t, i18n } = useTranslation();
    const lineHeight = useNoteLineHeight();
    const reduceMotion = useReducedMotion();
    const liteMode = useDisplayPrefsStore((s) => s.liteMode);
    const note = useNoteInk();
    const pending = !reason ? pendingMode : undefined;

    // An in-mount transition only: a box first drawn with its note never
    // animates (virtualised remounts, a translation swap).
    const [sawWriting, setSawWriting] = useState(pending === 'writing');
    if (pending === 'writing' && !sawWriting) setSawWriting(true);
    const revealing = !!reason && sawWriting;
    const [revealDone, setRevealDone] = useState(false);
    const wordByWord =
        revealing &&
        !revealDone &&
        !reduceMotion &&
        !liteMode &&
        // The note is written in English; a translated app fades it whole.
        (i18n.language ?? 'en').startsWith('en') &&
        !NO_SPACE_SCRIPT.test(reason);
    useEffect(() => {
        if (!wordByWord) return;
        const timer = setTimeout(() => setRevealDone(true), NOTE_REVEAL.total + 50);
        return () => clearTimeout(timer);
    }, [wordByWord]);

    // Fixed box on the Feed: badge row + the reserved lines, scaled with the
    // text, so writing, note and not-yet all draw the same height.
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

    if (pending === 'writing') {
        return (
            <Box testID={testID} className="rounded-lg px-3 pb-3" style={boxStyle}>
                <Animated.View
                    exiting={FadeOutUp.duration(180)}
                    style={{ flex: boxHeight ? 1 : undefined, flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: BADGE_ROW_PADDING }}
                    testID={testID ? `${testID}-writing` : undefined}
                    {...hideSlot}
                >
                    <MeraLogo size={WAIT_LOGO_SIZE} animated scrollCards color={note.ink} />
                    <View style={{ flex: 1 }}>
                        <WaitingFacts topicIds={topicIds} />
                    </View>
                </Animated.View>
            </Box>
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
                <Animated.View entering={revealing ? ZoomIn.springify().damping(SPRING.like.damping) : undefined}>
                    <RelevanceChip relevance={relevance} />
                </Animated.View>
                {reason ? (
                    <AiDisclosureCaption variant="compact" text={t('aiDisclosure.short')} color={note.ai} />
                ) : pending === 'not-yet' ? (
                    <Animated.View
                        entering={sawWriting ? FadeIn.duration(250) : undefined}
                        style={{ flex: 1, alignItems: 'flex-end' }}
                        testID={testID ? `${testID}-not-yet` : undefined}
                        {...hideSlot}
                    >
                        <Text size={NOTE_TOKEN} style={{ color: note.ink, textAlign: 'right' }}>
                            {t('feed.reasonNotYet')}
                        </Text>
                    </Animated.View>
                ) : null}
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
