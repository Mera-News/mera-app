import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { getRelevanceColors } from '@/lib/relevance-utils';
import { bandOf } from '@/lib/news-harness/feed-select/ownership';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { relevanceSpokenLabel } from '@/components/custom/relevance-spoken-label';

interface RelevanceChipProps {
    relevance: number;
}

/**
 * The chip is its WORD ("High", "Med", "Low"), never colour alone. The leading
 * arrow / dash glyphs (↑ ↓ –) are gone on owner review; only an EMERGENCY keeps
 * its `warning` glyph. Reads the band from `bandOf` (feed-select/ownership.ts),
 * the one band source, so it cannot fall out of step with the label and colour
 * `getRelevanceColors` gives the same score.
 */
function tierIcon(relevance: number): keyof typeof MaterialIcons.glyphMap | null {
    return bandOf(relevance) === 'EMERGENCY' ? 'warning' : null;
}

/** What VoiceOver says for each band (the word alone is too terse once the
 *  glyphs are gone). A sub-gate score reads as low. */


const RelevanceChip: React.FC<RelevanceChipProps> = ({ relevance }) => {
    const { t } = useTranslation();
    const colors = getRelevanceColors(relevance);
    const icon = tierIcon(relevance);

    return (
        <Box
            className="px-2 py-1 rounded-full"
            style={{ backgroundColor: colors.backgroundColor }}
            // One spoken label for the whole chip: "High priority", not "High".
            accessible
            accessibilityLabel={relevanceSpokenLabel(t, relevance)}
        >
            <HStack className="items-center" space="xs">
                {icon ? <MaterialIcons name={icon} size={11} color={colors.textColor} /> : null}
                {/* `size="2xs"` is 11px — the same pixels the inline override
                    was forcing, but declared once instead of a `size="xs"`
                    (12px) class fighting an inline `fontSize: 11`. On the scale
                    now, so it honours Dynamic Type and the text-size control. */}
                <Text
                    size="2xs"
                    style={{
                        color: colors.textColor,
                        fontWeight: '600',
                    }}
                >
                    {t(colors.label as any)}
                </Text>
            </HStack>
        </Box>
    );
};

export default RelevanceChip;
