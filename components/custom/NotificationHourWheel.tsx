// The multi-select hour wheel (owner: the ux1 picker, restored from 746dd4a0):
// a tall, endless column of hours; a tap toggles an hour, scrolling only
// moves the column. A picked hour is an accent-outlined box with an accent
// bold label. Any number of hours (unique 0-23, the server's only limit).
import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import React, { useCallback, useEffect, useRef } from 'react';
import { FlatList, NativeScrollEvent, NativeSyntheticEvent, Pressable, View } from 'react-native';

interface NotificationHourWheelProps {
    readonly selectedHours: readonly number[];
    readonly onHoursChange: (hours: number[]) => void;
    readonly use24h: boolean;
}

const HOURS = 24;
const ROW_HEIGHT = 50;
const CELL_SIZE = 44;
const VISIBLE_ROWS = 13;
const HALF_VISIBLE = (VISIBLE_ROWS - 1) / 2;
const INITIAL_CENTER_HOUR = 15; // 3 PM
const REPEATS = 401;
const CENTER_REPEAT = (REPEATS - 1) / 2;
const TOTAL_ROWS = HOURS * REPEATS;
const RECENTER_GUARD = HOURS * 20;
const INITIAL_TOP_INDEX = CENTER_REPEAT * HOURS + INITIAL_CENTER_HOUR - HALF_VISIBLE;
const ROWS = Array.from({ length: TOTAL_ROWS }, (_, i) => i);

export const formatHour = (h: number, use24h: boolean): string => {
    if (use24h) return h.toString().padStart(2, '0');
    if (h === 0) return '12 AM';
    if (h === 12) return '12 PM';
    return h < 12 ? `${h} AM` : `${h - 12} PM`;
};

interface RowProps {
    readonly label: string;
    readonly isSelected: boolean;
    readonly onPress: () => void;
    readonly accent: string;
    readonly accentText: string;
    readonly ink: string;
}

const Row: React.FC<RowProps> = React.memo(({ label, isSelected, onPress, accent, accentText, ink }) => (
    <View style={{ height: ROW_HEIGHT, alignItems: 'center', justifyContent: 'center' }}>
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: isSelected }}
            style={{
                width: CELL_SIZE,
                height: CELL_SIZE,
                borderRadius: 10,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: isSelected ? 1.5 : 0,
                borderColor: accent,
            }}
        >
            {/* ROW_HEIGHT is the wheel's scroll unit (snap, index, recentre), so
                the label is capped (`locked`) rather than the row grown. */}
            <Text
                size="2xs"
                scaleTier="locked"
                style={{ fontWeight: isSelected ? '700' : '500', color: isSelected ? accentText : ink }}
            >
                {label}
            </Text>
        </Pressable>
    </View>
));
Row.displayName = 'Row';

const NotificationHourWheel: React.FC<NotificationHourWheelProps> = ({ selectedHours, onHoursChange, use24h }) => {
    const colors = useColors();
    const listRef = useRef<FlatList<number>>(null);

    // Endless column: far from the middle repeat, jump back by whole days.
    const handleMomentumEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
        const topIndex = Math.round(e.nativeEvent.contentOffset.y / ROW_HEIGHT);
        const middle = CENTER_REPEAT * HOURS;
        if (Math.abs(topIndex - middle) > RECENTER_GUARD) {
            const hourOffset = ((topIndex % HOURS) + HOURS) % HOURS;
            listRef.current?.scrollToOffset({ offset: (middle + hourOffset) * ROW_HEIGHT, animated: false });
        }
    }, []);

    const toggleHour = useCallback(
        (hour: number) => {
            onHoursChange(
                selectedHours.includes(hour)
                    ? selectedHours.filter((h) => h !== hour)
                    : [...selectedHours, hour].sort((a, b) => a - b),
            );
        },
        [selectedHours, onHoursChange],
    );

    useEffect(() => {
        const id = requestAnimationFrame(() => {
            listRef.current?.scrollToOffset({ offset: INITIAL_TOP_INDEX * ROW_HEIGHT, animated: false });
        });
        return () => cancelAnimationFrame(id);
    }, []);

    const renderItem = useCallback(
        ({ item: rowIndex }: { item: number }) => {
            const hour = ((rowIndex % HOURS) + HOURS) % HOURS;
            return (
                <Row
                    label={formatHour(hour, use24h)}
                    isSelected={selectedHours.includes(hour)}
                    onPress={() => toggleHour(hour)}
                    accent={colors.accent}
                    accentText={colors.accentText}
                    ink={colors.ink}
                />
            );
        },
        [selectedHours, use24h, toggleHour, colors],
    );

    const getItemLayout = useCallback(
        (_: ArrayLike<number> | null | undefined, index: number) => ({
            length: ROW_HEIGHT,
            offset: ROW_HEIGHT * index,
            index,
        }),
        [],
    );

    return (
        <FlatList
            testID="hour-wheel"
            ref={listRef}
            data={ROWS}
            keyExtractor={(item: number) => String(item)}
            renderItem={renderItem}
            getItemLayout={getItemLayout}
            initialScrollIndex={INITIAL_TOP_INDEX}
            showsVerticalScrollIndicator={false}
            onMomentumScrollEnd={handleMomentumEnd}
            snapToInterval={ROW_HEIGHT}
            decelerationRate="normal"
            windowSize={5}
            initialNumToRender={VISIBLE_ROWS + 4}
            maxToRenderPerBatch={VISIBLE_ROWS + 4}
            removeClippedSubviews
            style={{ flex: 1 }}
        />
    );
};

export default NotificationHourWheel;
