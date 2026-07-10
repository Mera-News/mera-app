import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import React from 'react';

interface PolicyPillProps {
    label: string;
    onPress: () => void;
}

/**
 * Small rounded "pill" button used in the footer of the auth and preferences
 * screens to link out to the legal/policy pages (Privacy, Terms, Content).
 */
const PolicyPill: React.FC<PolicyPillProps> = ({ label, onPress }) => (
    <Pressable
        onPress={onPress}
        hitSlop={6}
        className="px-4 py-2 rounded-full border border-outline-100"
    >
        <Text size="xs" className="text-typography-500">
            {label}
        </Text>
    </Pressable>
);

export default PolicyPill;
