import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import FactCheckCard from '@/components/custom/fact-checks/FactCheckCard';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import { hapticLight } from '@/lib/haptics';
import {
    useFactCheckItems,
    useFactChecksHydrated,
    useFactChecksRefreshing,
    useFactChecksStore,
} from '@/lib/stores/fact-checks-store';
import type { StoredFactCheck } from '@/lib/database/services/fact-check-record-service';
import React, { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, RefreshControl } from 'react-native';

const REFRESH_TINT = '#EDA77E';

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
    const refreshing = useFactChecksRefreshing();
    const refresh = useFactChecksStore((s) => s.refresh);
    const remove = useFactChecksStore((s) => s.remove);

    // `refresh`, not `load`: a local-only read renders whatever the table
    // happens to hold, which is exactly how a server-side COMPLETE check kept
    // showing "Still searching". One bounded server read per unresolved row.
    useEffect(() => {
        void refresh();
    }, [refresh]);

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
                // The manual path. With the poll gone, a result can only arrive
                // via a read or a push — so a user who suspects the list is
                // stale must have a way to ask that does not depend on a
                // notification having been delivered.
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={() => { void refresh(); }}
                        tintColor={REFRESH_TINT}
                        colors={[REFRESH_TINT]}
                    />
                }
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
