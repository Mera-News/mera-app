import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { tint, useColors } from '@/lib/theme/tokens';
import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Marks a setting as beta. Not a suffix baked into the title string: baked-in
 * copy is 2 titles × 20 locales today and unremovable without another 40-edit
 * pass, where a badge is 1 locale key × 20 and composes with the next feature
 * that needs the same label. The text always comes from `common.beta` — a
 * hardcoded Latin "BETA" would be wrong in scripts like ja/zh/ru/ar/ko/th/hi.
 *
 * Two forms:
 *  - `pill` (default): a small pill beside a title. `tone="negative"` draws it
 *    red, the on-device colour (D30).
 *  - `subtext`: a small red "Beta" line under a title, for everything that runs
 *    on this phone. Always red.
 *
 * `scaleTier="chrome"` caps how far the label grows under Dynamic Type, same
 * as other chrome-role text in this app (row labels, chip counts). `shrink-0`
 * is required at the call site's usage, not decorative here: callers place
 * the pill beside a `Text` inside a `VStack className="flex-1"`, so without it
 * a long localized title at large Dynamic Type would crush the badge instead of
 * wrapping around it. No hand-coded margin — callers use `HStack space="xs"`
 * so the gap flips correctly under RTL (`ar`).
 */
const BetaBadge: React.FC<{
    testID?: string;
    tone?: 'primary' | 'negative';
    variant?: 'pill' | 'subtext';
}> = ({ testID, tone = 'primary', variant = 'pill' }) => {
    const { t } = useTranslation();
    const colors = useColors();

    if (variant === 'subtext') {
        return (
            <Text
                testID={testID ?? 'beta-badge'}
                size="2xs"
                scaleTier="chrome"
                className="font-semibold"
                style={{ color: colors.negative, marginTop: 2 }}
            >
                {t('common.beta')}
            </Text>
        );
    }

    if (tone === 'negative') {
        // `negative` is a plain CSS variable in the Tailwind theme, so opacity
        // modifiers (`border-negative/40`) would not apply: tint it here.
        return (
            <Box
                testID={testID ?? 'beta-badge'}
                className="shrink-0 rounded-full border px-2 py-0.5"
                style={{ borderColor: tint(colors.negative, 0.4), backgroundColor: tint(colors.negative, 0.1) }}
            >
                <Text size="2xs" scaleTier="chrome" className="font-semibold uppercase" style={{ color: colors.negative }}>
                    {t('common.beta')}
                </Text>
            </Box>
        );
    }

    return (
        <Box
            testID={testID ?? 'beta-badge'}
            className="shrink-0 rounded-full border border-primary-400/40 bg-primary-500/10 px-2 py-0.5"
        >
            <Text
                size="2xs"
                scaleTier="chrome"
                className="font-semibold uppercase text-primary-400"
            >
                {t('common.beta')}
            </Text>
        </Box>
    );
};

export default BetaBadge;
