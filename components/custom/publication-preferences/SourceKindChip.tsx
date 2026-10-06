import { Text } from '@/components/ui/text';
import type { PublicationPrefKind } from '@/lib/database/services/publication-preference-service';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

/** Board colours: More green, Fewer neutral, Muted red. */
const CHIP: Record<PublicationPrefKind, { bg: string; fg: string; key: 'you.sources.more' | 'you.sources.fewer' | 'you.sources.muted' }> = {
    boost: { bg: 'rgba(110,190,160,0.18)', fg: '#A9DCC7', key: 'you.sources.more' },
    deprioritize: { bg: 'rgba(255,255,255,0.10)', fg: '#D4D4D4', key: 'you.sources.fewer' },
    mute: { bg: 'rgba(239,68,68,0.16)', fg: '#F7B4B4', key: 'you.sources.muted' },
};

/** A source's setting as More / Fewer / Muted: the Sources screen and the
 *  Profile hub's Sources card use these words, never Boost or Downrank. */
const SourceKindChip: React.FC<{ readonly kind: PublicationPrefKind; readonly testID?: string }> = ({ kind, testID }) => {
    const { t } = useTranslation();
    const c = CHIP[kind];
    return (
        <View testID={testID} style={{ borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, backgroundColor: c.bg }}>
            <Text scaleTier="chrome" style={{ color: c.fg, fontSize: 12, fontWeight: '700' }}>
                {t(c.key)}
            </Text>
        </View>
    );
};

export default SourceKindChip;
