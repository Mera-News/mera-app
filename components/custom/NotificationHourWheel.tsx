import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import React, { useCallback, useEffect, useRef } from 'react';
import {
    AccessibilityActionEvent,
    FlatList,
    NativeScrollEvent,
    NativeSyntheticEvent,
    Pressable,
    View,
} from 'react-native';

const HOURS = 24;
/** One row. 44pt so a tapped row is a full touch target. Every bit of scroll
 *  maths divides by it (snap, index from offset, recentre), so it is a unit,
 *  not decoration: change it only together with all of that. */
export const WHEEL_ROW_HEIGHT = 44;
const VISIBLE_ROWS = 5;
const CENTER_OFFSET = (VISIBLE_ROWS - 1) / 2; // 2: the outlined row
const REPEATS = 401;
const CENTER_REPEAT = (REPEATS - 1) / 2;
const TOTAL_ROWS = HOURS * REPEATS;
const RECENTER_GUARD = HOURS * 20;
const ROWS = Array.from({ length: TOTAL_ROWS }, (_, i) => i);

const hourOf = (rowIndex: number) => ((rowIndex % HOURS) + HOURS) % HOURS;
/** The top row index that puts `hour` in the outlined centre, in the middle repeat. */
const topIndexFor = (hour: number) => CENTER_REPEAT * HOURS + hour - CENTER_OFFSET;

/**
 * "08:00" in 24-hour mode, the locale's own short hour ("8 AM", "오전 8시") in
 * 12-hour mode. A malformed language tag throws in some Hermes builds, so the
 * English form is the fallback rather than a crash.
 */
export function formatHourLabel(hour: number, use24h: boolean, language?: string): string {
    if (use24h) return `${hour.toString().padStart(2, '0')}:00`;
    try {
        return new Intl.DateTimeFormat(language, { hour: 'numeric', hour12: true }).format(
            new Date(2000, 0, 1, hour),
        );
    } catch {
        const h = hour % 12 === 0 ? 12 : hour % 12;
        return `${h} ${hour < 12 ? 'AM' : 'PM'}`;
    }
}

interface NotificationHourWheelProps {
    /** The hour in the outlined centre row (0-23). */
    readonly cursorHour: number;
    readonly onCursorChange: (hour: number) => void;
    /** A tapped row (or a screen reader's activate on the outlined hour) is a
     *  pick: the screen saves it. Spinning only moves the cursor. */
    readonly onPickHour: (hour: number) => void;
    /** Picked hours render in the accent colour; the wheel never edits them. */
    readonly pickedHours: readonly number[];
    readonly format: (hour: number) => string;
    /** Spoken name of the control, e.g. "Time to add". */
    readonly accessibilityLabel: string;
}

/**
 * A spinning hour picker: five rows, the centre one outlined. Spinning moves
 * the outlined hour; tapping a row brings it to the centre AND picks it.
 *
 * To VoiceOver and TalkBack it is ONE adjustable control (swipe up or down to
 * move an hour, double tap to pick the outlined one); the rows are not
 * separate stops, since a screen reader cannot spin 9,624 rows.
 */
const NotificationHourWheel: React.FC<NotificationHourWheelProps> = ({
    cursorHour,
    onCursorChange,
    onPickHour,
    pickedHours,
    format,
    accessibilityLabel,
}) => {
    const colors = useColors();
    const listRef = useRef<FlatList<number>>(null);
    // The top row index the list rests on. A ref, not state: it feeds scroll
    // commands, never rendering.
    const topIndexRef = useRef(topIndexFor(cursorHour));

    const scrollToTop = useCallback((topIndex: number, animated: boolean) => {
        topIndexRef.current = topIndex;
        listRef.current?.scrollToOffset({ offset: topIndex * WHEEL_ROW_HEIGHT, animated });
    }, []);

    // initialScrollIndex alone has landed a row off on first layout (seen on
    // the simulator: 07 outlined where 08 was asked for), and a frame-later
    // fix raced it. Set the offset once the list has its size instead.
    const onListLayout = useCallback(() => scrollToTop(topIndexRef.current, false), [scrollToTop]);

    // Only a finger moves the cursor. A scroll end that follows a programmatic
    // scroll (the layout fix above, a tap, a reset) is ignored, or a list that
    // landed a row off would report that row as the reader's choice.
    const draggingRef = useRef(false);
    const onDragBegin = useCallback(() => {
        draggingRef.current = true;
    }, []);

    // A cursor moved from outside (accessibility action, a reset) scrolls the
    // wheel there, by the shortest way round from where it rests.
    useEffect(() => {
        const current = topIndexRef.current;
        if (hourOf(current + CENTER_OFFSET) === cursorHour) return;
        let delta = cursorHour - hourOf(current + CENTER_OFFSET);
        if (delta > HOURS / 2) delta -= HOURS;
        if (delta < -HOURS / 2) delta += HOURS;
        scrollToTop(current + delta, true);
    }, [cursorHour, scrollToTop]);

    const settle = useCallback(
        (y: number) => {
            if (!draggingRef.current) return;
            draggingRef.current = false;
            let topIndex = Math.round(y / WHEEL_ROW_HEIGHT);
            const middle = CENTER_REPEAT * HOURS;
            if (Math.abs(topIndex - middle) > RECENTER_GUARD) {
                topIndex = middle + hourOf(topIndex);
                scrollToTop(topIndex, false);
            }
            topIndexRef.current = topIndex;
            const hour = hourOf(topIndex + CENTER_OFFSET);
            if (hour !== cursorHour) onCursorChange(hour);
        },
        [cursorHour, onCursorChange, scrollToTop],
    );

    const onMomentumEnd = useCallback(
        (e: NativeSyntheticEvent<NativeScrollEvent>) => settle(e.nativeEvent.contentOffset.y),
        [settle],
    );
    // A slow drag can end with no momentum phase at all, so a drag end with
    // no velocity settles too.
    const onDragEnd = useCallback(
        (e: NativeSyntheticEvent<NativeScrollEvent>) => {
            if (Math.abs(e.nativeEvent.velocity?.y ?? 0) < 0.05) settle(e.nativeEvent.contentOffset.y);
        },
        [settle],
    );

    const onAccessibilityAction = useCallback(
        (e: AccessibilityActionEvent) => {
            if (e.nativeEvent.actionName === 'increment') onCursorChange((cursorHour + 1) % HOURS);
            if (e.nativeEvent.actionName === 'decrement') onCursorChange((cursorHour + HOURS - 1) % HOURS);
            if (e.nativeEvent.actionName === 'activate') onPickHour(cursorHour);
        },
        [cursorHour, onCursorChange, onPickHour],
    );

    const renderItem = useCallback(
        ({ item: rowIndex }: { item: number }) => {
            const hour = hourOf(rowIndex);
            const distance = Math.min(Math.abs(hour - cursorHour), HOURS - Math.abs(hour - cursorHour));
            const picked = pickedHours.includes(hour);
            const fontSize = distance === 0 ? 30 : distance === 1 ? 22 : 18;
            const opacity = distance === 0 ? 1 : distance === 1 ? 0.75 : 0.4;
            // "08:00" draws its minutes dimmer; a 12-hour label has no colon.
            const label = format(hour);
            const colon = label.indexOf(':');
            return (
                <Pressable
                    testID={`hour-wheel-row-${hour}`}
                    onPress={() => {
                        scrollToTop(rowIndex - CENTER_OFFSET, true);
                        if (hour !== cursorHour) onCursorChange(hour);
                        onPickHour(hour);
                    }}
                    style={{ height: WHEEL_ROW_HEIGHT, alignItems: 'center', justifyContent: 'center', opacity }}
                >
                    {/* `locked`: the row height is the wheel's scroll unit. */}
                    <Text
                        scaleTier="locked"
                        style={{
                            fontSize,
                            lineHeight: fontSize + 6,
                            fontWeight: distance === 0 ? '700' : '500',
                            color: picked ? colors.accentText : colors.ink,
                        }}
                    >
                        {colon < 0 ? label : label.slice(0, colon)}
                        {colon < 0 ? null : <Text scaleTier="locked" style={{ opacity: 0.6 }}>{label.slice(colon)}</Text>}
                    </Text>
                </Pressable>
            );
        },
        [cursorHour, pickedHours, format, onCursorChange, onPickHour, scrollToTop, colors],
    );

    const getItemLayout = useCallback(
        (_: ArrayLike<number> | null | undefined, index: number) => ({
            length: WHEEL_ROW_HEIGHT,
            offset: WHEEL_ROW_HEIGHT * index,
            index,
        }),
        [],
    );

    return (
        <View
            testID="hour-wheel"
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={accessibilityLabel}
            accessibilityValue={{ text: format(cursorHour) }}
            accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }, { name: 'activate' }]}
            onAccessibilityAction={onAccessibilityAction}
            style={{ height: WHEEL_ROW_HEIGHT * VISIBLE_ROWS }}
        >
            {/* The outlined centre row, drawn behind the list. */}
            <View
                pointerEvents="none"
                style={{
                    position: 'absolute',
                    left: 12,
                    right: 12,
                    top: WHEEL_ROW_HEIGHT * CENTER_OFFSET,
                    height: WHEEL_ROW_HEIGHT,
                    borderRadius: 12,
                    backgroundColor: colors.line,
                    borderWidth: 1,
                    borderColor: colors.accent,
                }}
            />
            <FlatList
                ref={listRef}
                data={ROWS}
                keyExtractor={(item: number) => String(item)}
                renderItem={renderItem}
                extraData={cursorHour}
                getItemLayout={getItemLayout}
                initialScrollIndex={topIndexRef.current}
                showsVerticalScrollIndicator={false}
                onLayout={onListLayout}
                onScrollBeginDrag={onDragBegin}
                onMomentumScrollEnd={onMomentumEnd}
                onScrollEndDrag={onDragEnd}
                snapToInterval={WHEEL_ROW_HEIGHT}
                decelerationRate="fast"
                // The screen scrolls too (onboarding and small phones).
                nestedScrollEnabled
                windowSize={5}
                initialNumToRender={VISIBLE_ROWS + 4}
                maxToRenderPerBatch={VISIBLE_ROWS + 4}
                removeClippedSubviews
            />
        </View>
    );
};

export default NotificationHourWheel;
