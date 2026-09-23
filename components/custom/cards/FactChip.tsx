import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { reasonBoxColors } from '@/lib/relevance-utils';
import { router } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';

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
            // The chip is ~28pt tall; the slop makes the target 44pt.
            hitSlop={{ top: 8, bottom: 8 }}
            className="self-start mt-2 rounded-full px-3 py-1.5"
            style={({ pressed }) => ({
                borderWidth: 1,
                borderColor: reasonBoxColors.textColor,
                opacity: pressed ? 0.7 : 1,
            })}
        >
            <Text
                size="xs"
                numberOfLines={1}
                style={{ color: reasonBoxColors.textColor, fontWeight: '600' }}
            >
                {t('factChip.label', { label })} ›
            </Text>
        </Pressable>
    );
};

export default FactChip;
