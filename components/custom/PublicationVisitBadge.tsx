import { HStack } from '@/components/ui/hstack';
import {
    Popover,
    PopoverArrow,
    PopoverBackdrop,
    PopoverBody,
    PopoverContent,
} from '@/components/ui/popover';
import { navigateToPage } from '@/components/custom/nav/navigate-to-page';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { getVisitCountForPublication } from '@/lib/database/services/publication-visit-service';
import { useDisplayPublication } from '@/lib/stores/publication-display-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useColors } from '@/lib/theme/tokens';
import { useWindowDimensions } from 'react-native';

interface Props {
    publicationName: string | null | undefined;
    countryCode: string | null | undefined;
}

const PublicationVisitBadge: React.FC<Props> = ({ publicationName, countryCode }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const { width: screenWidth } = useWindowDimensions();
    const [count, setCount] = useState<number | null>(null);
    const [tooltipOpen, setTooltipOpen] = useState(false);
    // Display only; the visit count below is looked up by the raw name.
    const publicationShown = useDisplayPublication((publicationName ?? '').trim());

    useEffect(() => {
        const name = (publicationName ?? '').trim();
        if (!name) {
            setCount(0);
            return;
        }
        let cancelled = false;
        getVisitCountForPublication(name, countryCode ?? null)
            .then((c) => {
                if (!cancelled) setCount(c);
            })
            .catch(() => {
                if (!cancelled) setCount(0);
            });
        return () => {
            cancelled = true;
        };
    }, [publicationName, countryCode]);

    const openTooltip = useCallback(() => setTooltipOpen(true), []);
    const closeTooltip = useCallback(() => setTooltipOpen(false), []);

    const openHistory = useCallback(() => {
        setTooltipOpen(false);
        // The Library's Visited page, through the one way code opens a page.
        navigateToPage('visited');
    }, []);

    if (!publicationName || !count) return null;

    return (
        <Popover
            isOpen={tooltipOpen}
            onClose={closeTooltip}
            placement="bottom left"
            offset={6}
            crossOffset={0}
            size="sm"
            // VoiceOver could not reach the bubble: gluestack portals popover
            // content to the app root, outside the native screen. A native
            // modal is on top, and VoiceOver moves into it.
            useRNModal
            trigger={(triggerProps) => (
                <Pressable
                    {...triggerProps}
                    onPress={openTooltip}
                    accessibilityLabel={t('publicationVisits.tooltipA11y')}
                    className="rounded-lg p-3 bg-page border border-ink"
                >
                    <HStack className="items-center" space="sm">
                        <MaterialIcons name="visibility" size={16} color={colors.ink} />
                        <Text size="xs" italic className="flex-1 text-ink">
                            {t('publicationVisits.badge', {
                                publication: publicationShown,
                                count,
                            })}
                        </Text>
                    </HStack>
                </Pressable>
            )}
        >
            <PopoverBackdrop />
            {/* No surface classes: the popover primitive owns the material.
                bg-page + border-ink here would paint a frame around the
                plate rather than replacing it. */}
            <PopoverContent style={{ maxWidth: screenWidth - 32 }}>
                <PopoverArrow className="bg-page border border-line" />
                <PopoverBody
                    testID="publication-visit-bubble"
                    // VoiceOver's escape (two-finger scrub) closes the bubble.
                    onAccessibilityEscape={closeTooltip}
                >
                    {/* ONE link element. The link used to be a nested Text with
                        onPress, which iOS does not expose on its own, so
                        VoiceOver could not activate it. The whole sentence is
                        the tap target now, and reads intro, then the link. */}
                    <Pressable
                        accessibilityRole="link"
                        accessibilityLabel={`${t('publicationVisits.tooltipIntro')} ${t('publicationVisits.tooltipLink')}`}
                        onPress={openHistory}
                    >
                        <Text size="xs" className="text-ink">
                            {t('publicationVisits.tooltipIntro')}{' '}
                            <Text size="xs" bold className="text-ink underline">
                                {t('publicationVisits.tooltipLink')}
                            </Text>
                        </Text>
                    </Pressable>
                </PopoverBody>
            </PopoverContent>
        </Popover>
    );
};

export default PublicationVisitBadge;
