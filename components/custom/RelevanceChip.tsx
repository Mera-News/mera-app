import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { getRelevanceColors } from '@/lib/relevance-utils';
import { bandOf } from '@/lib/news-harness/feed-select/ownership';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface RelevanceChipProps {
    relevance: number;
}

/**
 * Per-tier icon so the chip is never color-only (a11y decision, Wave 7c N2):
 * emergency `warning`, high `arrow-upward`, medium `remove`, low
 * `arrow-downward`. Reads the band from `bandOf` (feed-select/ownership.ts) —
 * the unified band source of truth as of relevance v3 (2026-08-05) — instead of
 * a private hardcoded copy of the cutoffs, so this icon can never fall out of
 * step with `getRelevanceColors`'s label/color or the Dashboard/feed-ordering
 * band for the SAME relevance value.
 */
function tierIcon(relevance: number): keyof typeof MaterialIcons.glyphMap {
    switch (bandOf(relevance)) {
        case 'EMERGENCY': return 'warning';
        case 'HIGH': return 'arrow-upward';
        case 'MEDIUM': return 'remove';
        case 'LOW': return 'arrow-downward';
        default: return 'remove'; // SUB_GATE (incl. negative/unprocessed)
    }
}

const RelevanceChip: React.FC<RelevanceChipProps> = ({ relevance }) => {
    const { t } = useTranslation();
    const colors = getRelevanceColors(relevance);

    return (
        <Box
            className="px-2 py-1 rounded-full"
            style={{ backgroundColor: colors.backgroundColor }}
        >
            <HStack className="items-center" space="xs">
                <MaterialIcons
                    name={tierIcon(relevance)}
                    size={11}
                    color={colors.textColor}
                />
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
