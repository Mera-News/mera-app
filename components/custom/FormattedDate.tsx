import { Text } from '@/components/ui/text';
import React from 'react';

interface FormattedDateProps {
    dateString: string;
    size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
    className?: string;
}

export const FormattedDate: React.FC<FormattedDateProps> = ({
    dateString,
    size = 'xs',
    className = 'text-typography-500'
}) => {
    // Format date as "4 May, 3:00 pm"
    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        const day = date.getDate();
        const month = date.toLocaleDateString('en-US', { month: 'short' });
        const hours = date.getHours();
        const minutes = date.getMinutes().toString().padStart(2, '0');
        const ampm = hours >= 12 ? 'pm' : 'am';
        const displayHours = hours % 12 || 12;
        return `${day} ${month}, ${displayHours}:${minutes} ${ampm}`;
    };

    return (
        <Text size={size} className={className}>
            {formatDate(dateString)}
        </Text>
    );
};

export default FormattedDate;
