import { Text } from '@/components/ui/text';
import type { PublicationPrefKind } from '@/lib/database/services/publication-preference-service';
import { useColors } from '@/lib/theme/tokens';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

/** The words the article's ••• menu uses: More from, Fewer from, Muted. */
const LABEL: Record<PublicationPrefKind, 'publicationPage.moreFrom' | 'publicationPage.fewerFrom' | 'you.sources.muted'> = {
    boost: 'publicationPage.moreFrom',
    deprioritize: 'publicationPage.fewerFrom',
    mute: 'you.sources.muted',
};

/** A source's setting as a trailing pill (FinalProfile #13): More green,
 *  Fewer neutral, Muted red. Never Boost or Downrank. */
const SourceKindChip: React.FC<{ readonly kind: PublicationPrefKind; readonly testID?: string }> = ({ kind, testID }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const tint = kind === 'boost' ? colors.positive : kind === 'mute' ? colors.negative : null;
    return (
        <View testID={testID} style={{ borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, overflow: 'hidden' }}>
            <View
                style={[
                    StyleSheet.absoluteFill,
                    tint ? { backgroundColor: tint, opacity: 0.18 } : { backgroundColor: colors.surfaceRaised },
                ]}
            />
            <Text scaleTier="chrome" style={{ color: tint ?? colors.ink2, fontSize: 12, fontWeight: '700' }}>
                {t(LABEL[kind])}
            </Text>
        </View>
    );
};

export default SourceKindChip;
