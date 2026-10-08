// The picked notification times (owner: the pre-navx2 picker): a 24-hour
// strip, removable pills, and the hour wheel, which only moves the outlined
// hour; "Add" picks it. Any number of times, up to every hour of the day
// (unique hours are the only limit, on the server too).
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

/** The picked-hour pill is 36pt; its remove control is a 44pt frame that
 *  bleeds 4pt above and below and 12pt each side of its 20pt glyph. */
const PILL_HEIGHT = 36;
const REMOVE_FRAME = 44;

/** Where the wheel starts: 08:00 when it is free, else the first free hour
 *  after the latest pick, so Add is ready to use. */
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

    const cursorPicked = hours.includes(cursorHour);
    const addCursorHour = () => {
        if (cursorPicked) return;
        onChange([...hours, cursorHour].sort((a, b) => a - b));
    };
    const removeHour = (hour: number) => onChange(hours.filter((h) => h !== hour));

    // Decorative: the pills below carry the same information to a screen reader.
    const hourStrip = () => {
        const ticks = [0, 6, 12, 18];
        const labels = [...ticks, ...hours.filter((h) => ticks.every((tk) => Math.abs(tk - h) >= 2))];
        return (
            <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                className="mx-4 mb-3"
                style={{ ...card, paddingTop: 14, paddingHorizontal: 14, paddingBottom: 10 }}
            >
                <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 22, gap: 2 }}>
                    {Array.from({ length: 24 }, (_, h) => {
                        const picked = hours.includes(h);
                        return (
                            <View
                                key={h}
                                style={{
                                    flex: 1,
                                    height: picked ? 22 : 8,
                                    borderRadius: picked ? 3 : 2,
                                    backgroundColor: picked ? colors.accent : colors.trackBorder,
                                }}
                            />
                        );
                    })}
                </View>
                <View style={{ height: 16, marginTop: 4 }}>
                    {labels.map((h) => (
                        <Text
                            key={h}
                            size="2xs"
                            scaleTier="locked"
                            style={{
                                position: 'absolute',
                                left: `${(h / 24) * 100}%`,
                                color: hours.includes(h) ? colors.accentText : colors.ink3,
                                fontWeight: hours.includes(h) ? '700' : '400',
                            }}
                        >
                            {use24h ? h.toString().padStart(2, '0') : format(h)}
                        </Text>
                    ))}
                </View>
            </View>
        );
    };

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
                        onPress={() => removeHour(h)}
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
                            <MaterialIcons name="close" size={14} color={colors.ink} />
                        </View>
                    </Pressable>
                </View>
            ))}
            <Pressable
                testID="notifications-add-time"
                onPress={addCursorHour}
                accessibilityRole="button"
                accessibilityLabel={
                    cursorPicked
                        ? t('you.notifications.alreadyPicked', { time: format(cursorHour) })
                        : t('you.notifications.addHour', { time: format(cursorHour) })
                }
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
                    {cursorPicked ? null : <MaterialIcons name="add" size={16} color={colors.accentText} />}
                    <Text style={{ color: colors.accentText, fontSize: 14, fontWeight: '600', marginLeft: cursorPicked ? 0 : 4 }}>
                        {cursorPicked
                            ? t('you.notifications.alreadyPicked', { time: format(cursorHour) })
                            : t('you.notifications.add')}
                    </Text>
                </View>
            </Pressable>
        </View>
    );

    const none = hours.length === 0;
    return (
        <VStack>
            <Text size="xs" className="mx-4 mb-2" style={{ color: colors.ink3 }}>
                {none ? t('you.notifications.noneYet') : t('you.notifications.yourTimes')}
            </Text>
            {none ? (
                <Text
                    testID="notifications-zero-times"
                    size="sm"
                    className="mx-4 mb-3"
                    style={{ color: colors.warning }}
                    accessibilityLiveRegion="polite"
                >
                    {t('you.notifications.zeroTimes')}
                </Text>
            ) : null}
            {hourStrip()}
            {none ? null : pills()}
            <View className="mx-4 mb-3" style={{ ...card, borderRadius: 18, paddingVertical: 6 }}>
                <NotificationHourWheel
                    cursorHour={cursorHour}
                    onCursorChange={setCursorHour}
                    pickedHours={hours}
                    format={format}
                    accessibilityLabel={t('you.notifications.wheel')}
                />
            </View>
            {none ? (
                // First pick: one obvious button for the outlined hour.
                <Pressable
                    testID="notifications-add-first"
                    onPress={addCursorHour}
                    accessibilityRole="button"
                    accessibilityLabel={t('you.notifications.addHour', { time: format(cursorHour) })}
                    className="mx-4 mb-3 items-center justify-center rounded-full"
                    style={{ minHeight: 44, backgroundColor: colors.accent }}
                >
                    <Text style={{ color: colors.onAccent, fontWeight: '700', fontSize: 15 }}>
                        {t('you.notifications.addHour', { time: format(cursorHour) })}
                    </Text>
                </Pressable>
            ) : null}
            <Text size="xs" className="mx-4 mb-2" style={{ color: colors.ink3, lineHeight: 17 }}>
                {t('you.notifications.footnote')}
            </Text>
        </VStack>
    );
};

export default NotificationTimes;
