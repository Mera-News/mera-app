import { Box } from '@/components/ui/box';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MeraLogo from './MeraLogo';

const AllCaughtUpCard: React.FC = () => {
    const { t } = useTranslation();
    const [currentIndex, setCurrentIndex] = useState(0);
    const messages = t('feed.mindfulness', { returnObjects: true }) as string[];

    // Cycle through messages every second
    useEffect(() => {
        const interval = setInterval(() => {
            setCurrentIndex((prevIndex) => (prevIndex + 1) % messages.length);
        }, 3000);

        return () => clearInterval(interval);
    }, [messages.length]);

    return (
        <Card
            variant="elevated"
            size="md"
            className="mb-4 overflow-hidden bg-black border-black"
        >
            <Box className="w-full py-20 px-6 items-center justify-center">
                {/* Mera Logo */}
                <Box className="mb-6">
                    <MeraLogo size={100} />
                </Box>

                {/* "You're all caught up" text */}
                <Text
                    size="xl"
                    className="text-white text-center mb-4 font-semibold"
                >
                    {t('feed.allCaughtUp')}
                </Text>

                {/* Cycling mindfulness message */}
                <Text
                    size="md"
                    className="text-gray-400 text-center"
                >
                    {messages[currentIndex]}
                </Text>
            </Box>
        </Card>
    );
};

export default AllCaughtUpCard;
