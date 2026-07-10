import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { useThemeColors } from '@/lib/theme/tokens';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    FlatList,
    NativeScrollEvent,
    NativeSyntheticEvent,
    Pressable,
    View,
} from 'react-native';

interface NotificationHourWheelProps {
    selectedHours: number[];
    onHoursChange: (hours: number[]) => void;
    maxHours?: number;
    showCounter?: boolean;
    use24h?: boolean;
    height?: number;
}

const HOURS = 24;
const ROW_HEIGHT = 50;
const CELL_SIZE = 44;
const VISIBLE_ROWS = 13;
const HALF_VISIBLE = (VISIBLE_ROWS - 1) / 2; // 6
const INITIAL_CENTER_HOUR = 15; // 3 PM
const REPEATS = 401;
const CENTER_REPEAT = (REPEATS - 1) / 2;
const TOTAL_ROWS = HOURS * REPEATS;
const RECENTER_GUARD = HOURS * 20;
const INITIAL_TOP_INDEX = CENTER_REPEAT * HOURS + INITIAL_CENTER_HOUR - HALF_VISIBLE;

const formatHour = (h: number, use24h: boolean): string => {
    if (use24h) return h.toString().padStart(2, '0');
    if (h === 0) return '12 AM';
    if (h === 12) return '12 PM';
    return h < 12 ? `${h} AM` : `${h - 12} PM`;
};

interface RowProps {
    label: string;
    isSelected: boolean;
    isDisabled: boolean;
    onPress: () => void;
}

const Row: React.FC<RowProps> = React.memo(({ label, isSelected, isDisabled, onPress }) => {
    const colors = useThemeColors();
    return (
    <View style={{ height: ROW_HEIGHT, alignItems: 'center', justifyContent: 'center' }}>
        <Pressable
            onPress={onPress}
            disabled={isDisabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ selected: isSelected, disabled: isDisabled }}
            style={{
                width: CELL_SIZE,
                height: CELL_SIZE,
                borderRadius: 10,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'transparent',
                borderWidth: isSelected ? 1.5 : 0,
                borderColor: colors.primary,
            }}
        >
            <Text
                style={{
                    fontSize: 11,
                    fontWeight: isSelected ? '700' : '500',
                    color: isSelected ? colors.primary : colors.icon,
                }}
            >
                {label}
            </Text>
        </Pressable>
    </View>
    );
});
Row.displayName = 'Row';

const NotificationHourWheel: React.FC<NotificationHourWheelProps> = ({
    selectedHours,
    onHoursChange,
    maxHours = 24,
    showCounter = true,
    use24h = false,
    height,
}) => {
    const toast = useToast();
    const listRef = useRef<FlatList<number>>(null);
    // The settled index value itself is unused; only the setter drives the
    // recenter side-effect below. Keep state so React batches the recenter.
    const [, setSettledTopIndex] = useState(INITIAL_TOP_INDEX);

    const handleMomentumEnd = useCallback(
        (e: NativeSyntheticEvent<NativeScrollEvent>) => {
            const y = e.nativeEvent.contentOffset.y;
            const topIndex = Math.round(y / ROW_HEIGHT);
            setSettledTopIndex(topIndex);

            const middle = CENTER_REPEAT * HOURS;
            if (Math.abs(topIndex - middle) > RECENTER_GUARD) {
                const hourOffset = ((topIndex % HOURS) + HOURS) % HOURS;
                const target = middle + hourOffset;
                listRef.current?.scrollToOffset({
                    offset: target * ROW_HEIGHT,
                    animated: false,
                });
                setSettledTopIndex(target);
            }
        },
        [],
    );

    const toggleHour = useCallback(
        (hour24: number) => {
            if (selectedHours.includes(hour24)) {
                onHoursChange(selectedHours.filter(h => h !== hour24));
            } else if (selectedHours.length < maxHours) {
                onHoursChange([...selectedHours, hour24].sort((a, b) => a - b));
            } else {
                toast.show({
                    placement: 'top',
                    render: () => (
                        <Toast action="error" variant="solid">
                            <ToastTitle>Maximum Reached</ToastTitle>
                            <ToastDescription>
                                You can select up to {maxHours} hours
                            </ToastDescription>
                        </Toast>
                    ),
                });
            }
        },
        [selectedHours, onHoursChange, maxHours, toast],
    );

    useEffect(() => {
        const id = requestAnimationFrame(() => {
            listRef.current?.scrollToOffset({
                offset: INITIAL_TOP_INDEX * ROW_HEIGHT,
                animated: false,
            });
        });
        return () => cancelAnimationFrame(id);
    }, []);

    const renderItem = useCallback(
        ({ item: rowIndex }: { item: number }) => {
            const hour = ((rowIndex % HOURS) + HOURS) % HOURS;
            const isSelected = selectedHours.includes(hour);
            return (
                <Row
                    label={formatHour(hour, use24h)}
                    isSelected={isSelected}
                    isDisabled={false}
                    onPress={() => toggleHour(hour)}
                />
            );
        },
        [selectedHours, use24h, toggleHour],
    );

    const getItemLayout = useCallback(
        (_: ArrayLike<number> | null | undefined, index: number) => ({
            length: ROW_HEIGHT,
            offset: ROW_HEIGHT * index,
            index,
        }),
        [],
    );

    const wheelStyle = height ? { height } : { flex: 1 };

    return (
        <Box style={wheelStyle}>
            <FlatList
                ref={listRef}
                data={Array.from({ length: TOTAL_ROWS }, (_, i) => i)}
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

            {showCounter && (
                <Text size="sm" className="text-center mt-2 text-typography-500">
                    Selected: {selectedHours.length}/{maxHours}
                </Text>
            )}
        </Box>
    );
};

export default NotificationHourWheel;
