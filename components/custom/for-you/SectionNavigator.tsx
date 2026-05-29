import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import React from 'react';

export type SectionItem = { label: string; shortLabel: string };

type Props = {
    sections: SectionItem[];
    activeSection: string | null;
    onSelect: (label: string) => void;
};

const SectionNavigator: React.FC<Props> = ({ sections, activeSection, onSelect }) => {
    if (sections.length === 0) return null;
    return (
        <HStack className="w-full justify-between">
            {sections.map(({ label, shortLabel }) => (
                <Pressable
                    key={label}
                    onPress={() => onSelect(shortLabel)}
                    className={`flex-1 mx-2 items-center py-2 rounded-full border ${activeSection === shortLabel ? 'border-orange-500' : 'border-gray-700'}`}
                >
                    <Text
                        size="sm"
                        className={`font-medium ${activeSection === shortLabel ? 'text-orange-500' : 'text-gray-500'}`}
                    >
                        {shortLabel}
                    </Text>
                </Pressable>
            ))}
        </HStack>
    );
};

export default SectionNavigator;
