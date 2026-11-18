import { Text } from '@/components/ui/text';
import { useColors } from '@/lib/theme/tokens';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { ServicePage } from './ModeSwitchRow';

/** One tap down from the own AI page: what turning it on does to the rest of the app. */
export default function WhatChangesScreen({ onBack }: { readonly onBack?: () => void }) {
    const { t } = useTranslation();
    const colors = useColors();
    const lines = [t('ownServices.ai.changes.uses'), t('ownServices.ai.changes.off'), t('ownServices.ai.changes.verify')];
    return (
        <ServicePage title={t('ownServices.ai.changes.title')} onBack={onBack}>
            <View style={{ gap: 12, marginHorizontal: 4 }}>
                {lines.map((line) => (
                    <Text key={line} style={{ color: colors.ink, fontSize: 16, lineHeight: 22 }}>{line}</Text>
                ))}
            </View>
        </ServicePage>
    );
}
