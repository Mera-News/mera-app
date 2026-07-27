import { SourceFlag } from '@/components/custom/SourceFlag';
import {
    Popover,
    PopoverArrow,
    PopoverBackdrop,
    PopoverBody,
    PopoverContent,
} from '@/components/ui/popover';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { getCountryName } from '@/lib/country-utils';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
    countryCode?: string | null;
    /** Color class for the fallback globe icon (used when there's no country code). */
    iconClassName?: string;
}

/**
 * A source-country flag that, when tapped, reveals a small popover naming the
 * country. Used on the article detail screen. When the country can't be named
 * (no / unrecognised code), it renders a plain, non-interactive flag.
 */
export const SourceCountryFlag: React.FC<Props> = ({ countryCode, iconClassName }) => {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const closeTooltip = useCallback(() => setOpen(false), []);
    const openTooltip = useCallback(() => setOpen(true), []);

    const flag = <SourceFlag countryCode={countryCode} size="sm" iconClassName={iconClassName} />;

    const label = !countryCode
        ? null
        : countryCode === 'GLOBAL'
          ? t('articleDetail.sourceCountryGlobal')
          : getCountryName(countryCode);

    // Nothing meaningful to name (missing / unrecognised code) — render the
    // plain flag with no tap affordance.
    if (!label || label === countryCode) {
        return flag;
    }

    return (
        <Popover
            isOpen={open}
            onClose={closeTooltip}
            placement="bottom left"
            offset={6}
            size="sm"
            trigger={(triggerProps) => (
                <Pressable
                    {...triggerProps}
                    onPress={openTooltip}
                    hitSlop={8}
                    accessibilityLabel={t('articleDetail.sourceCountryA11y', { country: label })}
                >
                    {flag}
                </Pressable>
            )}
        >
            <PopoverBackdrop />
            <PopoverContent className="bg-background-900">
                <PopoverArrow className="bg-background-900" />
                <PopoverBody>
                    <Text size="xs" className="text-typography-50">
                        {label}
                    </Text>
                </PopoverBody>
            </PopoverContent>
        </Popover>
    );
};

export default SourceCountryFlag;
