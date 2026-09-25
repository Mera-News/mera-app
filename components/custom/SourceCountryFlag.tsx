import { SourceFlag } from '@/components/custom/SourceFlag';
import {
    Popover,
    PopoverBackdrop,
    PopoverBody,
    PopoverContent,
} from '@/components/ui/popover';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { getCountryName } from '@/lib/country-utils';
import { router } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
    countryCode?: string | null;
    /** Color class for the fallback globe icon (used when there's no country code). */
    iconClassName?: string;
}

/**
 * A source-country flag that, when tapped, reveals a small popover naming the
 * country; the name is a link to that country's publication list (the same
 * route the Sources list opens), owner ux2 B4. Used on the article detail screen. When the country can't be named
 * (no / unrecognised code), it renders a plain, non-interactive flag.
 */
export const SourceCountryFlag: React.FC<Props> = ({ countryCode, iconClassName }) => {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const closeTooltip = useCallback(() => setOpen(false), []);
    const openTooltip = useCallback(() => setOpen(true), []);
    // `countryCode` is the article's own (alpha-3, or GLOBAL for the Global
    // list), the same code the Sources list passes for a country row.
    const openCountry = useCallback(
        (countryName: string) => {
            setOpen(false);
            if (!countryCode) return;
            router.push({
                pathname: '/logged-in/sources-publishers',
                params: { countryCode, countryName },
            });
        },
        [countryCode],
    );

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
            // "left" (no cross-word) opens BESIDE the chip, vertically centered
            // on it, instead of below/above. The flag is always the row's
            // last (right-most) element with a headline flowing immediately
            // below the row, so a "bottom"-placed tooltip lands squarely on
            // top of that headline the moment there's room below in the
            // viewport — which is the common case, not an edge case. Opening
            // sideways keeps the tooltip's vertical footprint pinned near the
            // chip's own row regardless of what precedes/follows it
            // vertically, so it's safe whether the chip sits above a
            // headline (today) or below one (e.g. a future footer chip).
            // The underlying gluestack-ui positioner (useOverlayPosition)
            // still flips left<->right and clamps the cross (vertical) axis
            // against the window bounds, so edge-of-screen cards stay
            // fully on-screen for free.
            placement="left"
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
            {/* No PopoverArrow: its border-trim reads the originally-requested
                placement (not the post-flip one), so it would mis-render
                whenever the positioner flips left<->right near a screen edge.
                A borderless bubble is a fine, and safer, treatment for a
                one-line country name. Width is capped well below the
                narrowest supported screen so the positioner's left<->right
                flip (not a boundary clamp, on this axis) always has room to
                land the content fully on-screen. */}
            {/* No surface classes: the popover primitive owns the material now. This
                call site used to invert itself into a LIGHT bubble
                (bg-background-900 + text-typography-50) because the surface
                underneath was an opaque slab; keeping that override left the
                caller's light fill showing as a frame around the plate, with
                dark text on a dark panel inside it. */}
            <PopoverContent className="max-w-[200px]">
                <PopoverBody>
                    {/* A link: VoiceOver reads "<country>, link". */}
                    <Pressable
                        testID="source-country-link"
                        accessibilityRole="link"
                        accessibilityLabel={label}
                        onPress={() => openCountry(label)}
                        hitSlop={12}
                    >
                        <Text size="xs" className="text-typography-900 underline">
                            {label}
                        </Text>
                    </Pressable>
                </PopoverBody>
            </PopoverContent>
        </Popover>
    );
};

export default SourceCountryFlag;
