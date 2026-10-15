import { Text } from '@/components/ui/text';
import { fetchUserReading } from '@/lib/billing-service';
import { checkRequirements } from '@/lib/mera-protocol-toolkit/core/systemRequirements';
import { useIsOnDeviceProcessing } from '@/lib/stores/mera-protocol-store';
import { getPlanRaisedAt, tierMultiplier } from '@/lib/subscription/plan-rise';
import { getReadHoldUpdatedAt, isReadHeld, useReadHold } from '@/lib/subscription/read-hold';
import { useColors } from '@/lib/theme/tokens';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { readingMeterModel } from './reading-meter-model';

/** "02:00" in the reader's own time and locale; null when unusable. */
export function formatResetTime(at: string | number | null | undefined, language?: string): string | null {
    if (at == null || at === '') return null;
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return null;
    try {
        return date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
    } catch {
        return date.toLocaleTimeString();
    }
}

/**
 * Fetches the reading meter on mount and on every focus (the tab stays
 * mounted). `online` is whether that fetch answered; the hold itself is
 * written by `fetchUserReading` and read back by ReadingMeter.
 */
export function useReadingFetch(tier: string | null | undefined): ReadingMeterProps {
    const [reading, setReading] = useState<{ used: number | null; multiplier: number } | null>(null);
    const [online, setOnline] = useState(false);
    useFocusEffect(
        useCallback(() => {
            let live = true;
            void fetchUserReading().then((r) => {
                if (!live) return;
                setOnline(r !== null);
                setReading(r ? { used: r.readingUsed, multiplier: r.planMultiplier } : null);
            });
            return () => {
                live = false;
            };
        }, []),
    );
    return { used: reading?.used ?? null, online, multiplier: reading?.multiplier ?? tierMultiplier(tier) };
}

export interface ReadingMeterProps {
    /** The server's share used (0..1) from the latest answer; null when none. */
    used: number | null;
    online: boolean;
    multiplier: number;
    size?: 'card' | 'screen';
}

/** Text only: the day's reading as a bar, when it resets, and what the plan means. */
const ReadingMeter: React.FC<ReadingMeterProps> = ({ used, online, multiplier, size = 'card' }) => {
    const { t, i18n } = useTranslation();
    const colors = useColors();
    const hold = useReadHold();
    const onDevice = useIsOnDeviceProcessing();
    const [supported, setSupported] = useState(false);
    const [, tick] = useState(0);

    useEffect(() => {
        let live = true;
        void checkRequirements().then((r) => live && setSupported(r.supported)).catch(() => {});
        return () => {
            live = false;
        };
    }, []);

    // Expiry emits nothing, so while held, look again until the hold ends.
    const held = isReadHeld();
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
        onDeviceSupported: supported,
        multiplier,
        planRaised: getPlanRaisedAt() != null,
    });

    if (m.showOfflineOnly) {
        return <Text style={{ color: colors.muted, fontSize: 13 }}>{t('you.settings.usageOffline')}</Text>;
    }

    const lang = i18n?.language;
    const title = t('you.settings.readingToday');
    const percent = m.percent ?? 0;
    const percentText = m.done
        ? t('you.settings.readingDone')
        : t('you.settings.readingUsed', { percent: new Intl.NumberFormat(lang, { style: 'percent' }).format(percent / 100) });
    const time = formatResetTime(m.resetAt, lang) ?? '';
    const height = size === 'screen' ? 6 : 4;
    const small = { color: colors.ink2, fontSize: 13 } as const;

    return (
        <View testID="reading-meter" style={{ gap: 8 }}>
            <View style={{ gap: 8, opacity: m.dimmed ? 0.5 : 1 }}>
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
                <Text style={small}>{t('you.settings.lastUpdated', { time: formatResetTime(m.lastUpdatedAt, lang) ?? '' })}</Text>
            ) : null}
            <Text style={small}>
                {m.multiplierKey === 'base' ? t('you.settings.planMultiplierBase') : t('you.settings.planMultiplier', { n: multiplier })}
            </Text>
            {m.showUnlimitedLine ? <Text style={small}>{t('you.settings.onDeviceUnlimited')}</Text> : null}
            {m.showOnPhoneLine ? <Text style={small}>{t('you.settings.readingOnPhone')}</Text> : null}
            {m.showNewPlan ? <Text style={small}>{t('you.settings.newPlanApplies')}</Text> : null}
        </View>
    );
};

export default ReadingMeter;
