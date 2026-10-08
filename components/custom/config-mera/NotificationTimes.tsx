// The picked notification times (owner: the ux1 picker, restored from
// 746dd4a0): "Selected" and the count on the left, the multi-select hour
// wheel in the middle, the 24h | AM/PM toggle on the right. The row takes the
// height its host gives it (flex: 1), so the wheel shrinks before anything
// around it does.
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
import { View } from 'react-native';

/** The wheel column: a 44pt cell plus its margin. */
const WHEEL_WIDTH = 64;

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

const NotificationTimes: React.FC<NotificationTimesProps> = ({ hours, onChange }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const [use24h, setUse24h] = useState(deviceUses24h);

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
                // A 44pt frame around the ~28pt segment.
                style={{ height: 44, marginVertical: -8, justifyContent: 'center' }}
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

    return (
        <View style={{ flex: 1, minHeight: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14 }}>
            <View style={{ flex: 1, alignItems: 'center' }}>
                <Text size="sm" style={{ color: colors.ink3 }}>
                    {t('notifications.selectedLabel')}
                </Text>
                <Text size="md" style={{ color: colors.ink, fontWeight: '600' }} testID="notifications-selected-count">
                    {hours.length}
                </Text>
            </View>
            <View style={{ width: WHEEL_WIDTH, alignSelf: 'stretch' }}>
                <NotificationHourWheel selectedHours={hours} onHoursChange={onChange} use24h={use24h} />
            </View>
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <View
                    accessibilityRole="radiogroup"
                    style={{ flexDirection: 'row', borderRadius: 999, padding: 2, backgroundColor: colors.surface }}
                >
                    {segment(true)}
                    {segment(false)}
                </View>
            </View>
        </View>
    );
};

export default NotificationTimes;
