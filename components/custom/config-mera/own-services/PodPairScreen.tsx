import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { ServicePage } from './ModeSwitchRow';

/** The two steps for pairing with the Camera app or a link. */
export default function PodPairScreen({ onBack }: { readonly onBack?: () => void }) {
    const { t } = useTranslation();
    const colors = useColors();
    const steps = [t('ownServices.pod.pairStep1'), t('ownServices.pod.pairStep2')];
    return (
        <ServicePage title={t('ownServices.pod.pairTitle')} onBack={onBack}>
            {steps.map((text, i) => (
                <View key={i} style={{ flexDirection: 'row', gap: 10, marginHorizontal: 4, marginBottom: 14 }}>
                    <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: colors.ink2, fontSize: 16, lineHeight: 22, fontWeight: '700' }}>{`${i + 1}.`}</Text>
                    <Text style={{ flex: 1, color: colors.ink, fontSize: 16, lineHeight: 22 }}>{text}</Text>
                </View>
            ))}
        </ServicePage>
    );
}
