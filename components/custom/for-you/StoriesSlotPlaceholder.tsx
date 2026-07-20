import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Empty-state placeholder for the Stories sub-tab. A later wave swaps this file's
 * body for the real TrackedStoriesScreen embed; the interface is intentionally
 * trivial (no props) so that swap is a one-file change.
 */
const StoriesSlotPlaceholder: React.FC = () => {
    const { t } = useTranslation();
    return (
        <Box className="flex-1 items-center justify-center px-8">
            <MaterialIcons name="auto-awesome" size={48} color="#6B7280" />
            <Text size="lg" className="text-white text-center font-semibold mt-4">
                {t('trackedStories.emptyTitle')}
            </Text>
            <Text size="sm" className="text-typography-400 text-center mt-2">
                {t('trackedStories.emptyBody')}
            </Text>
        </Box>
    );
};

export default StoriesSlotPlaceholder;
