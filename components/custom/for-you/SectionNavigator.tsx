import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';

export type SectionItem = { label: string; shortLabel: string };

type Props = {
    sections: SectionItem[];
    activeSection: string | null;
    onSelect: (label: string) => void;
};

const SectionNavigator: React.FC<Props> = ({ sections, activeSection, onSelect }) => {
    const { t } = useTranslation();
    if (sections.length === 0) return null;

    const pills = sections.map(({ label, shortLabel }) => (
        <Pressable
            key={label}
            onPress={() => onSelect(shortLabel)}
            className={`mx-2 items-center py-2 rounded-full border ${activeSection === shortLabel ? 'border-primary-500' : 'border-outline-100'} ${sections.length <= 3 ? 'flex-1' : 'px-4'}`}
        >
            <Text
                size="sm"
                className={`font-medium ${activeSection === shortLabel ? 'text-primary-500' : 'text-typography-400'}`}
            >
                {t(shortLabel as any)}
            </Text>
        </Pressable>
    ));

    if (sections.length > 3) {
        return (
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 4 }}
            >
                {pills}
            </ScrollView>
        );
    }

    return (
        <HStack className="w-full justify-between">
            {pills}
        </HStack>
    );
};

export default SectionNavigator;
