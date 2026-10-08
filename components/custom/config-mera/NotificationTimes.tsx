// The picked notification times (owner: the ux1 picker, restored from
// 746dd4a0): "Selected" and the count, the multi-select hour wheel, and the
// 24h | AM/PM toggle. Side by side while the label and the toggle fit their
// columns at the current text size, else stacked: Selected and the toggle in
// one row above a full-width wheel (notification-times-layout.ts).
//
// The block takes the height its host gives it (flex: 1, minHeight 0) and the
// wheel fills what is left INSIDE it as an absolutely positioned list, so the
// wheel is what shrinks when text grows, never the host's buttons.
//
// Shared by Settings > Notifications and the first launch notifications step
// (onboarding), so it saves nothing itself: it reports the new list.
import NotificationHourWheel from '@/components/custom/NotificationHourWheel';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import { getCalendars } from 'expo-localization';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { TIMES_SIDE_PAD, WHEEL_WIDTH, timesLayout } from './notification-times-layout';

/** The toggle starts at the phone's own clock setting; it is not stored. */
export function deviceUses24h(): boolean {
    try {
        return getCalendars()[0]?.uses24hourClock !== false;
    } catch {
        return true;
    }
}

export interface NotificationTimesProps {
    /** Local hours, sorted. */
    readonly hours: readonly number[];
    readonly onChange: (hours: number[]) => void;
}

/** An invisible, untouchable copy laid out at its natural width. */
const MEASURE = { position: 'absolute', opacity: 0, left: 0, top: 0, flexDirection: 'row' } as const;

const widthOf = (set: (w: number) => void) => (e: LayoutChangeEvent) => set(Math.ceil(e.nativeEvent.layout.width));

const NotificationTimes: React.FC<NotificationTimesProps> = ({ hours, onChange }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const [use24h, setUse24h] = useState(deviceUses24h);
    const [available, setAvailable] = useState(0);
    const [labelWidth, setLabelWidth] = useState(0);
    const [toggleWidth, setToggleWidth] = useState(0);
    const layout = timesLayout(available, labelWidth, toggleWidth);

    const segment = (is24: boolean) => {
        const active = use24h === is24;
        const label = is24 ? t('notifications.format24h') : t('notifications.formatAmPm');
        return (
            <Pressable
                key={label}
                testID={is24 ? 'notifications-format-24h' : 'notifications-format-ampm'}
                onPress={() => setUse24h(is24)}
                accessibilityRole="radio"
                accessibilityState={{ selected: active, checked: active }}
                accessibilityLabel={label}
                // A 44pt frame around the segment.
                style={{ minHeight: 44, marginVertical: -8, justifyContent: 'center' }}
            >
                <View
                    style={{
                        paddingHorizontal: 12,
                        paddingVertical: 6,
                        borderRadius: 999,
                        backgroundColor: active ? colors.surfaceRaised : 'transparent',
                    }}
                >
                    <Text size="xs" style={{ fontWeight: '500', color: active ? colors.ink : colors.ink3 }}>
                        {label}
                    </Text>
                </View>
            </Pressable>
        );
    };

    const toggle = (onLayout?: (e: LayoutChangeEvent) => void) => (
        <View
            accessibilityRole="radiogroup"
            onLayout={onLayout}
            style={{ flexDirection: 'row', alignSelf: 'center', borderRadius: 999, padding: 2, backgroundColor: colors.surface }}
        >
            {segment(true)}
            {segment(false)}
        </View>
    );

    const label = (
        <Text size="sm" style={{ color: colors.ink3 }}>
            {t('notifications.selectedLabel')}
        </Text>
    );
    const count = (
        <Text size="md" style={{ color: colors.ink, fontWeight: '600' }} testID="notifications-selected-count">
            {hours.length}
        </Text>
    );

    // The wheel fills its box; the box's size comes from the layout, never
    // from the list's content.
    const wheel = (boxStyle: object) => (
        <View style={boxStyle}>
            <View style={StyleSheet.absoluteFill}>
                <NotificationHourWheel selectedHours={hours} onHoursChange={onChange} use24h={use24h} />
            </View>
        </View>
    );

    return (
        <View style={{ flex: 1, minHeight: 0, paddingHorizontal: TIMES_SIDE_PAD }} onLayout={widthOf(setAvailable)}>
            {/* Natural widths of the label and the toggle at the current text
                size, measured off screen; they decide the layout. */}
            <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={MEASURE}>
                <View onLayout={widthOf(setLabelWidth)}>{label}</View>
            </View>
            <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={MEASURE}>
                {toggle(widthOf(setToggleWidth))}
            </View>

            {layout === 'side' ? (
                <View style={{ flex: 1, minHeight: 0, flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{ flex: 1, alignItems: 'center' }}>
                        {label}
                        {count}
                    </View>
                    {wheel({ width: WHEEL_WIDTH, alignSelf: 'stretch' })}
                    <View style={{ flex: 1, alignItems: 'center' }}>{toggle()}</View>
                </View>
            ) : (
                <View style={{ flex: 1, minHeight: 0 }}>
                    <View
                        style={{
                            flexDirection: 'row',
                            flexWrap: 'wrap',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            rowGap: 8,
                            columnGap: 12,
                            marginBottom: 8,
                        }}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'baseline', columnGap: 8, flexShrink: 1 }}>
                            {label}
                            {count}
                        </View>
                        {toggle()}
                    </View>
                    {wheel({ flex: 1, minHeight: 0 })}
                </View>
            )}
        </View>
    );
};

export default NotificationTimes;
