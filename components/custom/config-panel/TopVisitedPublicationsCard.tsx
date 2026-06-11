import { SourceFlag } from '@/components/custom/SourceFlag';
import { Box } from '@/components/ui/box';
import { Card } from '@/components/ui/card';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { VisitedPublication } from '@/lib/database/services/publication-visit-service';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
    topPublications: VisitedPublication[];
}

const TopVisitedPublicationsCard: React.FC<Props> = ({ topPublications }) => {
    const { t } = useTranslation();

    const handlePress = useCallback(() => {
        router.push({ pathname: '/logged-in/visited-publications' });
    }, []);

    if (topPublications.length === 0) return null;

    return (
        <Pressable onPress={handlePress}>
            <Card variant="elevated" size="sm" className="mx-4 mt-3 mb-2 rounded-xl">
                <VStack className="p-3" space="sm">
                    <HStack className="items-center justify-between">
                        <Text size="sm" bold className="text-white">
                            {t('publicationVisits.topVisitedTitle')}
                        </Text>
                        <MaterialIcons name="chevron-right" size={18} color="#999999" />
                    </HStack>
                    <VStack space="xs">
                        {topPublications.map((p) => (
                            <HStack
                                key={`${p.publicationName}::${p.countryCode ?? ''}`}
                                className="items-center justify-between"
                                space="sm"
                            >
                                <HStack className="items-center flex-1 mr-3" space="sm">
                                    <SourceFlag countryCode={p.countryCode} size="lg" />
                                    <Text
                                        size="sm"
                                        className="text-white flex-1"
                                        numberOfLines={1}
                                    >
                                        {p.publicationName}
                                    </Text>
                                </HStack>
                                <Box className="px-2 py-0.5 rounded-full bg-background-800">
                                    <Text size="xs" className="text-typography-400">
                                        {t('publicationVisits.countShort', { count: p.visitCount })}
                                    </Text>
                                </Box>
                            </HStack>
                        ))}
                    </VStack>
                </VStack>
            </Card>
        </Pressable>
    );
};

export default TopVisitedPublicationsCard;
