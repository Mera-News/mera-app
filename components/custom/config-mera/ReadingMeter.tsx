import BetaBadge from '@/components/custom/BetaBadge';
import { Text } from '@/components/ui/text';
import { fetchUserReading } from '@/lib/billing-service';
import { useIsOnDeviceProcessing } from '@/lib/stores/mera-protocol-store';
import { formatClockTime } from '@/lib/subscription/clock-time';
import { getPlanRaisedAt } from '@/lib/subscription/plan-rise';
import { getReadHoldUpdatedAt, isReadHeld, useReadHold } from '@/lib/subscription/read-hold';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { readingMeterModel } from './reading-meter-model';
import ReadHoldUpgradeButton from '@/components/custom/for-you/ReadHoldUpgradeButton';

/**
 * Fetches the reading meter on mount and on every focus (the tab stays
 * mounted). `online` is whether that fetch answered; the hold itself is
 * written by `fetchUserReading` and read back by ReadingMeter.
 */
export function useReadingFetch(): ReadingMeterProps {
    const [used, setUsed] = useState<number | null>(null);
    // null until the first answer: unknown is drawn as online (the stored figure, no
    // "Last updated"), or every focus would flash the offline line before the fetch lands.
    const [online, setOnline] = useState<boolean | null>(null);
    useFocusEffect(
        useCallback(() => {
            let live = true;
            void fetchUserReading().then((r) => {
                if (!live) return;
                setOnline(r !== null);
                setUsed(r ? r.readingUsed : null);
            });
            return () => {
                live = false;
            };
        }, []),
    );
    return { used, online: online !== false };
}

export interface ReadingMeterProps {
    /** The server's share used (0..1) from the latest answer; null when none. */
    used: number | null;
    online: boolean;
    size?: 'card' | 'screen';
}

/** One line with a glyph: "Processing mode  [glyph] Private cloud". Read as one element, glyph hidden. */
const GlyphRow: React.FC<{ icon: keyof typeof MaterialIcons.glyphMap; label?: string; value: string; testID?: string }> = ({ icon, label, value, testID }) => {
    const colors = useColors();
    return (
        <View
            testID={testID}
            accessible
            accessibilityLabel={label ? `${label}, ${value}` : value}
            // Without a label the glyph and value sit under the mode's value, on the trailing side.
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: label ? undefined : 'flex-end', gap: 8 }}
        >
            {label ? <Text style={{ flex: 1, color: colors.ink2, fontSize: 14 }}>{label}</Text> : null}
            <MaterialIcons name={icon} size={18} color={colors.ink} />
            <Text style={{ color: colors.ink, fontSize: 14, fontWeight: '600', flexShrink: 1 }}>{value}</Text>
        </View>
    );
};

/** The processing mode, then in the cloud the day's reading as a bar and when it resets; on device, unlimited. */
const ReadingMeter: React.FC<ReadingMeterProps> = ({ used, online, size = 'card' }) => {
    const { t, i18n } = useTranslation();
    const colors = useColors();
    const hold = useReadHold();
    const onDevice = useIsOnDeviceProcessing();
    const [, tick] = useState(0);

    // Expiry emits nothing, so while held, look again until the hold ends. On device is never held.
    const held = !onDevice && isReadHeld();
    useEffect(() => {
        if (!held) return;
        const id = setInterval(() => {
            tick((n) => n + 1);
            if (!isReadHeld()) clearInterval(id);
        }, 30_000);
        return () => clearInterval(id);
    }, [held]);

    const now = Date.now();
    const m = readingMeterModel({
        used: used ?? hold.used,
        held,
        holdResetAt: hold.resetAt,
        now,
        online,
        updatedAt: getReadHoldUpdatedAt(),
        onDevice,
        planRaised: getPlanRaisedAt() != null,
    });

    const modeRow = (
        <GlyphRow
            testID="reading-mode"
            icon={m.mode === 'onDevice' ? 'smartphone' : 'cloud'}
            label={t('you.settings.processingMode')}
            value={m.mode === 'onDevice' ? t('you.settings.onThisPhone') : t('you.settings.privateCloud')}
        />
    );

    // Checked before the offline-only line: on device needs no figure.
    if (m.mode === 'onDevice') {
        return (
            <View testID="reading-meter" style={{ gap: 8 }}>
                <View>
                    {modeRow}
                    {/* On this phone is in Beta (D30): the red subtext under its value. */}
                    <View style={{ alignItems: 'flex-end' }}>
                        <BetaBadge variant="subtext" testID="reading-on-phone-beta" />
                    </View>
                </View>
                <GlyphRow testID="reading-unlimited" icon="all-inclusive" value={t('you.settings.unlimited')} />
            </View>
        );
    }

    if (m.showOfflineOnly) {
        return (
            <View testID="reading-meter" style={{ gap: 8 }}>
                {modeRow}
                <Text style={{ color: colors.muted, fontSize: 13 }}>{t('you.settings.usageOffline')}</Text>
            </View>
        );
    }

    const lang = i18n?.language;
    const title = t('you.settings.readingToday');
    const percent = m.percent ?? 0;
    const percentText = m.done
        ? t('you.settings.readingDone')
        : t('you.settings.readingUsed', { percent: new Intl.NumberFormat(lang, { style: 'percent' }).format(percent / 100) });
    const time = formatClockTime(m.resetAt, lang) ?? '';
    const height = size === 'screen' ? 6 : 4;
    const small = { color: colors.ink2, fontSize: 13 } as const;

    return (
        <View testID="reading-meter" style={{ gap: 8 }}>
            {modeRow}
            <View style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                    <Text style={{ color: colors.ink, fontSize: size === 'screen' ? 16 : 14, fontWeight: '600', flexShrink: 1 }}>{title}</Text>
                    <Text testID="reading-percent" style={{ color: colors.ink2, fontSize: 13, fontVariant: ['tabular-nums'] }}>{percentText}</Text>
                </View>
                <View
                    accessibilityRole="progressbar"
                    accessibilityLabel={title}
                    accessibilityValue={{ min: 0, max: 100, now: percent }}
                    style={{ height, borderRadius: height / 2, backgroundColor: colors.trackFill, overflow: 'hidden' }}
                >
                    <View style={{ width: `${percent}%`, height, backgroundColor: colors.accent }} />
                </View>
            </View>
            <Text style={small}>{t(m.resetDay === 'today' ? 'you.settings.resetsTodayAt' : 'you.settings.resetsTomorrowAt', { time })}</Text>
            {m.lastUpdatedAt != null ? (
                <Text style={small}>{t('you.settings.lastUpdated', { time: formatClockTime(m.lastUpdatedAt, lang) ?? '' })}</Text>
            ) : null}
            {m.showNewPlan ? <Text style={small}>{t('you.settings.newPlanApplies')}</Text> : null}
            {/* Settings only, while held and not Professional (the button gates itself). Manage plan
                has View plans and stays lean (owner). */}
            {size === 'card' && m.done ? <ReadHoldUpgradeButton testID="reading-upgrade" /> : null}
        </View>
    );
};

export default ReadingMeter;
