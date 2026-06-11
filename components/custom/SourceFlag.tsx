import { GlobeIcon, Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { getFlagEmoji } from '@/lib/country-utils';
import React from 'react';

type SourceFlagSize = 'sm' | 'lg' | 'xl';

interface SourceFlagProps {
    countryCode?: string | null;
    size?: SourceFlagSize;
    /** Color class for the fallback globe icon (used when there's no country code). */
    iconClassName?: string;
}

const EMOJI_CLASS: Record<SourceFlagSize, string> = {
    sm: 'text-sm',
    lg: 'text-lg',
    xl: 'text-xl',
};

/**
 * Renders a publication's country flag. A GLOBAL source shows the 🌍 emoji;
 * a source with no (or an unrecognised) country code falls back to a neutral globe icon.
 */
export const SourceFlag: React.FC<SourceFlagProps> = ({
    countryCode,
    size = 'sm',
    iconClassName = 'text-typography-500',
}) => {
    const flag = getFlagEmoji(countryCode);
    if (flag) {
        return <Text className={EMOJI_CLASS[size]}>{flag}</Text>;
    }
    return <Icon as={GlobeIcon} size={size} className={iconClassName} />;
};

export default SourceFlag;
