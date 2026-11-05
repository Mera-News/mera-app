import { Group } from '@/components/custom/you/rows';
import { Text } from '@/components/ui/text';
import { readLocalDataSizes, type LocalDataSizes } from '@/lib/database/local-data-size';
import { useColors } from '@/lib/theme/tokens';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions, View } from 'react-native';
import { meterFigures } from './data-meter-model';

const ROW_LABEL = {
    database: 'manageData.meterDatabase',
    model: 'meraProtocol.relevanceTitle',
    backup: 'manageData.meterBackup',
} as const;

/** What Mera keeps on this phone, read on focus. Nothing shows until the read answers, and nothing when it fails. */
const DataMeterCard: React.FC = () => {
    const { t, i18n } = useTranslation();
    const colors = useColors();
    const { fontScale } = useWindowDimensions();
    const [sizes, setSizes] = useState<LocalDataSizes | null>(null);
    useFocusEffect(
        useCallback(() => {
            void readLocalDataSizes().then(setSizes, () => setSizes(null));
        }, []),
    );
    if (!sizes) return null;

    const f = meterFigures(sizes, i18n.language);
    const stacked = fontScale >= 1.3;
    return (
        <>
            <Group testID="data-meter">
                <View style={{ padding: 16, gap: 8 }}>
                    <Text style={{ color: colors.ink, fontSize: 16, lineHeight: 21, fontWeight: '700' }}>
                        {t('manageData.meterTitle')}
                    </Text>
                    <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 19 }}>
                        {f.free === null
                            ? t('manageData.meterUsedOnly', { used: f.used })
                            : t('manageData.meterLine', { used: f.used, free: f.free })}
                    </Text>
                    {f.fraction === null ? null : (
                        <View
                            testID="data-meter-bar"
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                            style={{ flexDirection: 'row', height: 8, borderRadius: 4, backgroundColor: colors.surfaceRaised, overflow: 'hidden' }}
                        >
                            <View style={{ width: `${f.fraction * 100}%`, minWidth: 4, backgroundColor: colors.accent, borderRadius: 4 }} />
                        </View>
                    )}
                </View>
                {f.rows.map((r) => (
                    <View
                        key={r.key}
                        testID={`data-meter-row-${r.key}`}
                        style={{
                            flexDirection: stacked ? 'column' : 'row',
                            justifyContent: 'space-between',
                            gap: stacked ? 2 : 12,
                            paddingVertical: 10,
                            paddingHorizontal: 16,
                        }}
                    >
                        <Text style={{ color: colors.ink, fontSize: 15, flexShrink: 1 }}>{t(ROW_LABEL[r.key])}</Text>
                        <Text style={{ color: colors.ink2, fontSize: 15 }}>{r.value}</Text>
                    </View>
                ))}
            </Group>
            <View style={{ height: 14 }} />
        </>
    );
};

export default DataMeterCard;
