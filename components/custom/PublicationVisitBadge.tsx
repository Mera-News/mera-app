import { HStack } from '@/components/ui/hstack';
import {
    Popover,
    PopoverArrow,
    PopoverBackdrop,
    PopoverBody,
    PopoverContent,
} from '@/components/ui/popover';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { getVisitCountForPublication } from '@/lib/database/services/publication-visit-service';
import { useThemeColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowDimensions } from 'react-native';

interface Props {
    publicationName: string | null | undefined;
    countryCode: string | null | undefined;
}

const PublicationVisitBadge: React.FC<Props> = ({ publicationName, countryCode }) => {
    const { t } = useTranslation();
    const colors = useThemeColors();
    const { width: screenWidth } = useWindowDimensions();
    const [count, setCount] = useState<number | null>(null);
    const [tooltipOpen, setTooltipOpen] = useState(false);

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
        router.push({ pathname: '/logged-in/visited-publications' });
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
            trigger={(triggerProps) => (
                <Pressable
                    {...triggerProps}
                    onPress={openTooltip}
                    accessibilityLabel={t('publicationVisits.tooltipA11y')}
                    className="rounded-lg p-3 bg-background-0 border border-outline-200"
                >
                    <HStack className="items-center" space="sm">
                        <MaterialIcons name="visibility" size={16} color={colors.icon} />
                        <Text size="xs" italic className="flex-1 text-typography-950">
                            {t('publicationVisits.badge', {
                                publication: publicationName,
                                count,
                            })}
                        </Text>
                    </HStack>
                </Pressable>
            )}
        >
            <PopoverBackdrop />
            <PopoverContent
                className="bg-background-0 border border-outline-200"
                style={{ maxWidth: screenWidth - 32 }}
            >
                <PopoverArrow className="bg-background-0 border border-outline-200" />
                <PopoverBody>
                    <Text size="xs" className="text-typography-950">
                        {t('publicationVisits.tooltipIntro')}{' '}
                        <Text
                            size="xs"
                            bold
                            className="text-typography-950 underline"
                            onPress={openHistory}
                        >
                            {t('publicationVisits.tooltipLink')}
                        </Text>
                    </Text>
                </PopoverBody>
            </PopoverContent>
        </Popover>
    );
};

export default PublicationVisitBadge;
