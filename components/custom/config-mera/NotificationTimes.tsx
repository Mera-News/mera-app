// The picked notification times: dots on a 24-hour strip, removable pills,
// and the hour wheel. Tapping a wheel row saves that hour and closes the
// wheel; "Add a time" reopens it and hides at MAX_TIMES. With nothing picked
// the wheel is always open. Stored extra hours (from before the cap) stay.
//
// Shared by Settings > Notifications and the first launch notifications step
// (onboarding), so it saves nothing itself: it reports the new list.
import NotificationHourWheel, { formatHourLabel } from '@/components/custom/NotificationHourWheel';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import { getCalendars } from 'expo-localization';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

/** Up to three times (owner). More stored before the cap stay, untrimmed. */
export const MAX_TIMES = 3;
/** The picked-hour pill is 36pt; its remove control is a 44pt frame that
 *  bleeds 4pt above and below and 12pt each side of its 20pt glyph. */
const PILL_HEIGHT = 36;
const REMOVE_FRAME = 44;

/** Where the wheel starts: 08:00 when it is free, else the first free hour
 *  after the latest pick. */
export function initialCursorHour(picked: readonly number[]): number {
    if (!picked.includes(8)) return 8;
    const last = Math.max(...picked);
    for (let i = 1; i <= 24; i++) {
        const h = (last + i) % 24;
        if (!picked.includes(h)) return h;
    }
    return 8;
}

/** 24h vs AM/PM follows the phone's own clock setting; there is no toggle. */
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

const NotificationTimes: React.FC<NotificationTimesProps> = ({ hours, onChange }) => {
    const { t, i18n } = useTranslation();
    const colors = useColors();
    const [use24h] = useState(deviceUses24h);
    const [wheelOpen, setWheelOpen] = useState(false);
    const [cursorHour, setCursorHour] = useState(() => initialCursorHour(hours));
    const card = {
        borderRadius: 16,
        backgroundColor: colors.glass,
        borderWidth: 1,
        borderColor: colors.trackBorder,
    } as const;

    const format = useCallback(
        (h: number) => formatHourLabel(h, use24h, i18n?.language),
        [use24h, i18n?.language],
    );

    const pickHour = (hour: number) => {
        if (!hours.includes(hour)) {
            if (hours.length >= MAX_TIMES) return;
            onChange([...hours, hour].sort((a, b) => a - b));
        }
        setWheelOpen(false);
    };
    const openWheel = () => {
        setCursorHour(initialCursorHour(hours));
        setWheelOpen(true);
    };

    // Decorative: the pills below carry the same information to a screen
    // reader. Night (before 06, after 19) and day on one thin track, a dot
    // per picked hour.
    const hourStrip = () => (
        <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className="mx-4 mb-3"
            style={{ ...card, paddingTop: 14, paddingHorizontal: 14, paddingBottom: 10, gap: 10 }}
        >
            <View style={{ height: 4, borderRadius: 2, flexDirection: 'row', overflow: 'visible' }}>
                <View style={{ flex: 6, backgroundColor: colors.night, borderTopLeftRadius: 2, borderBottomLeftRadius: 2 }} />
                <View style={{ flex: 13, backgroundColor: colors.accent, opacity: 0.35 }} />
                <View style={{ flex: 5, backgroundColor: colors.night, borderTopRightRadius: 2, borderBottomRightRadius: 2 }} />
                {hours.map((h) => (
                    <View
                        key={h}
                        style={{
                            position: 'absolute',
                            left: `${(h / 24) * 100}%`,
                            top: -8,
                            width: 20,
                            height: 20,
                            marginLeft: -10,
                            borderRadius: 10,
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        <View style={{ position: 'absolute', width: 20, height: 20, borderRadius: 10, backgroundColor: colors.accent, opacity: 0.25 }} />
                        <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: colors.accent }} />
                    </View>
                ))}
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                {['00', '06', '12', '18', '24'].map((label) => (
                    <Text key={label} size="2xs" scaleTier="locked" style={{ color: colors.ink3 }}>
                        {label}
                    </Text>
                ))}
            </View>
        </View>
    );

    const pills = () => (
        <View className="mx-4 mb-3" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {hours.map((h) => (
                <View
                    key={h}
                    testID={`notifications-pill-${h}`}
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        height: PILL_HEIGHT,
                        marginVertical: (REMOVE_FRAME - PILL_HEIGHT) / 2,
                        paddingLeft: 14,
                        borderRadius: 999,
                        backgroundColor: colors.glass,
                        borderWidth: 1,
                        borderColor: colors.trackBorder,
                    }}
                >
                    <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '600' }}>{format(h)}</Text>
                    <Pressable
                        testID={`notifications-pill-remove-${h}`}
                        onPress={() => onChange(hours.filter((x) => x !== h))}
                        accessibilityRole="button"
                        accessibilityLabel={t('you.notifications.remove', { time: format(h) })}
                        style={{
                            width: REMOVE_FRAME,
                            height: REMOVE_FRAME,
                            marginVertical: -(REMOVE_FRAME - PILL_HEIGHT) / 2,
                            marginLeft: 6 - (REMOVE_FRAME - 20) / 2,
                            marginRight: 8 - (REMOVE_FRAME - 20) / 2,
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        <View
                            style={{
                                width: 20,
                                height: 20,
                                borderRadius: 10,
                                backgroundColor: colors.surfaceRaised,
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <MaterialIcons name="close" size={12} color={colors.ink} />
                        </View>
                    </Pressable>
                </View>
            ))}
            {!wheelOpen && hours.length < MAX_TIMES ? (
                <Pressable
                    testID="notifications-add-time"
                    onPress={openWheel}
                    accessibilityRole="button"
                    accessibilityLabel={t('you.notifications.add')}
                    style={{ height: REMOVE_FRAME, justifyContent: 'center' }}
                >
                    <View
                        style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            height: PILL_HEIGHT,
                            paddingHorizontal: 14,
                            borderRadius: 999,
                            borderWidth: 1,
                            borderStyle: 'dashed',
                            borderColor: colors.accent,
                        }}
                    >
                        <MaterialIcons name="add" size={16} color={colors.accentText} />
                        <Text style={{ color: colors.accentText, fontSize: 14, fontWeight: '600', marginLeft: 4 }}>
                            {t('you.notifications.add')}
                        </Text>
                    </View>
                </Pressable>
            ) : null}
        </View>
    );

    const none = hours.length === 0;
    return (
        <VStack>
            <Text size="xs" className="mx-4 mb-2" style={{ color: colors.ink3 }}>
                {none ? t('you.notifications.noneYet') : t('you.notifications.yourTimes')}
            </Text>
            {hourStrip()}
            {none ? null : pills()}
            {none || wheelOpen ? (
                <View className="mx-4 mb-3" style={{ ...card, borderRadius: 18, paddingVertical: 6 }}>
                    <NotificationHourWheel
                        cursorHour={cursorHour}
                        onCursorChange={setCursorHour}
                        onPickHour={pickHour}
                        pickedHours={hours}
                        format={format}
                        accessibilityLabel={t('you.notifications.wheel')}
                    />
                </View>
            ) : null}
            {/* One helper line: with the wheel open it starts with how to pick. */}
            <Text size="xs" className="mx-4 mb-2" style={{ color: colors.ink3, lineHeight: 17 }}>
                {none || wheelOpen
                    ? `${t('you.notifications.tapToSave')} ${t('you.notifications.footnoteNoCap')}`
                    : t('you.notifications.footnote')}
            </Text>
        </VStack>
    );
};

export default NotificationTimes;
