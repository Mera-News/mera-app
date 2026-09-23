import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface RelatedErrorRowProps {
    onRetry: () => void;
}

/**
 * Shown under "Related articles" when a related page failed to load. Without
 * it the section simply vanished (the hook stopped paging and the section's
 * gate saw no rows), which read as "this story has no coverage" rather than
 * "loading failed".
 */
const RelatedErrorRow: React.FC<RelatedErrorRowProps> = ({ onRetry }) => {
    const { t } = useTranslation();
    return (
        <HStack className="items-center justify-between py-2" space="md" testID="related-error">
            <Text size="sm" className="text-typography-400 flex-1">
                {t('articleDetail.relatedLoadFailed')}
            </Text>
            <Pressable
                onPress={onRetry}
                accessibilityRole="button"
                accessibilityLabel={t('common.retry')}
                hitSlop={8}
                testID="related-error-retry"
                style={({ pressed }) => ({
                    minHeight: 44,
                    justifyContent: 'center',
                    paddingHorizontal: 12,
                    opacity: pressed ? 0.6 : 1,
                })}
            >
                <Text size="sm" className="text-primary-400 font-semibold">
                    {t('common.retry')}
                </Text>
            </Pressable>
        </HStack>
    );
};

export default RelatedErrorRow;
