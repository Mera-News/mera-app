import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Small pill marking a setting as beta. Not a suffix baked into the title
 * string: baked-in copy is 2 titles × 20 locales today and unremovable
 * without another 40-edit pass, where a badge is 1 locale key × 20 and
 * composes with the next feature that needs the same label. The text always
 * comes from `common.beta` — a hardcoded Latin "BETA" would be wrong in
 * scripts like ja/zh/ru/ar/ko/th/hi.
 *
 * `scaleTier="chrome"` caps how far the label grows under Dynamic Type, same
 * as other chrome-role text in this app (row labels, chip counts). `shrink-0`
 * is required at the call site's usage, not decorative here: callers place
 * this beside a `Text` inside a `VStack className="flex-1"`, so without it a
 * long localized title at large Dynamic Type would crush the badge instead of
 * wrapping around it. No hand-coded margin — callers use `HStack space="xs"`
 * so the gap flips correctly under RTL (`ar`).
 */
const BetaBadge: React.FC<{ testID?: string }> = ({ testID }) => {
    const { t } = useTranslation();

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
