import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { router } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

/** The app accent (the menu glyphs, the Save fill). */
const CHIP_ACCENT = '#EDA77E';
const TARGET_STYLE = { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', marginTop: 4 } as const;
const PILL_STYLE = {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: CHIP_ACCENT,
    backgroundColor: 'rgba(237,167,126,0.14)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    maxWidth: '100%',
} as const;

export interface FactChipProps {
    /** The profile fact the story matched. Absent: nothing renders (a fact
     *  the user deleted must not leave a chip pointing at nothing). */
    fact: Fact | null | undefined;
    testID?: string;
}

/**
 * A2: "From your profile: <fact> ›" under Mera's note, naming the profile
 * fact the story was matched on. Tapping opens that fact's story list
 * (`/logged-in/fact-feed`). It is its own button with a 44pt target, so a tap
 * on it never falls through to whatever the note sits in.
 */
const FactChip: React.FC<FactChipProps> = ({ fact, testID = 'fact-chip' }) => {
    const { t } = useTranslation();
    if (!fact) return null;
    const label = fact.statement.trim();
    if (!label) return null;
    return (
        <Pressable
            testID={testID}
            accessibilityRole="link"
            accessibilityLabel={t('factChip.openA11y', { label })}
            onPress={() =>
                router.push({
                    pathname: '/logged-in/fact-feed',
                    params: { factId: fact.id, statement: fact.statement },
                })
            }
            // A 44pt target around a ~30pt pill. STATIC styles only: a function
            // `style` on a Pressable is dropped on device here, which is how the
            // first version of this chip rendered as plain text (K-3).
            style={TARGET_STYLE}
        >
            <View style={PILL_STYLE}>
                <Text size="xs" numberOfLines={1} style={{ color: CHIP_ACCENT, fontWeight: '600' }}>
                    {t('factChip.label', { label })} ›
                </Text>
            </View>
        </Pressable>
    );
};

export default FactChip;
