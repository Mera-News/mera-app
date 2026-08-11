import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import FactCheckCard from '@/components/custom/fact-checks/FactCheckCard';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { hapticLight } from '@/lib/haptics';
import {
    useFactCheckItems,
    useFactChecksHydrated,
    useFactChecksStore,
} from '@/lib/stores/fact-checks-store';
import type { StoredFactCheck } from '@/lib/database/services/fact-check-record-service';
import React, { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList } from 'react-native';

interface FactChecksScreenProps {
    readonly onBack: () => void;
}

/**
 * Every fact check this device has asked for, newest first, with a per-row
 * delete.
 *
 * Purely on-device — no server read at all. The rows come from `fact_checks`,
 * which the detail panel and the push handler both write to. Delete is
 * local-only and genuinely cheap: the server keeps its own cross-user cache, so
 * a deleted row can always be re-fetched by opening the article and asking
 * again. Nothing here is user-authored content that a delete could destroy.
 */
const FactChecksScreen: React.FC<FactChecksScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();
    const items = useFactCheckItems();
    const hydrated = useFactChecksHydrated();
    const load = useFactChecksStore((s) => s.load);
    const remove = useFactChecksStore((s) => s.remove);

    useEffect(() => {
        void load();
    }, [load]);

    const handleDelete = useCallback((id: string) => {
        void hapticLight();
        void remove(id);
    }, [remove]);

    const renderItem = useCallback(
        ({ item }: { item: StoredFactCheck }) => (
            <Box className="mb-3">
                <FactCheckCard item={item} onDelete={handleDelete} testIDPrefix="fact-check-list" />
            </Box>
        ),
        [handleDelete],
    );

    return (
        <Box className="flex-1" testID="fact-checks-screen">
            <DrillDownHeader
                title={t('factCheck.dashboard.listTitle')}
                subtitle={t('factCheck.dashboard.listSubtitle')}
                titleNumberOfLines={2}
                onBack={onBack}
            />
            <FlatList
                data={items}
                keyExtractor={(item) => item.id}
                renderItem={renderItem}
                testID="fact-checks-list"
                contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
                ListEmptyComponent={
                    // Only once a read has completed — otherwise the empty state
                    // flashes for a frame on every open before the rows land.
                    hydrated ? (
                        <Text
                            size="sm"
                            className="text-typography-400 text-center mt-10"
                            testID="fact-checks-empty"
                        >
                            {t('factCheck.dashboard.empty')}
                        </Text>
                    ) : null
                }
            />
        </Box>
    );
};

export default FactChecksScreen;
