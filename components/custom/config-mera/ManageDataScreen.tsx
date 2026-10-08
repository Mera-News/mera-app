import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import WhatMeraKeepsCard from '@/components/custom/config-mera/WhatMeraKeepsCard';
import DrillDownHeader, { SUBPAGE_TOP_GAP } from '@/components/custom/config-panel/DrillDownHeader';
import { Group, GroupLabel, Help, Row } from '@/components/custom/you/rows';
import { Spinner } from '@/components/ui/spinner';
import { backupCadence, backupProviderId } from '@/lib/backup/backup-settings';
import database from '@/lib/database';
import { clearAllVisits } from '@/lib/database/services/publication-visit-service';
import * as coldstartTimeline from '@/lib/diagnostics/coldstart-timeline';
import { showDialog } from '@/lib/dialog';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import * as scoringPipeline from '@/lib/services/scoring-pipeline';
import { useForYouStore } from '@/lib/stores';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { toastManager } from '@/lib/toast-manager';
import { Q } from '@nozbe/watermelondb';
import { router, useFocusEffect, type Href } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useExportHistory } from './use-export-history';

// Facts hold the user's topics, and the feed cache is built from those topics,
// so clearing facts must also clear the derived cache (and its topic-gen jobs)
// to avoid leaving stale or orphaned rows behind.
const FACTS_AND_TOPICS_TABLES = ['facts', 'article_suggestions', 'article_suggestion_facts', 'inference_jobs'];

interface ManageDataScreenProps {
    onBack?: () => void;
}

/**
 * Settings > Your data (FinalSettings #15): Backup as one row to its own
 * screen, then look at it and take it (What Mera keeps, Export reading
 * history), then Delete (Clear profile, Clear reading history). Delete account
 * sits above Log out in Settings (`use-delete-account.tsx`). No "Clear article
 * cache" (it clears itself) and no "Wipe all" (owner Y10).
 */
const ManageDataScreen: React.FC<ManageDataScreenProps> = ({ onBack }) => {
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();
    const [isProcessing, setIsProcessing] = useState(false);
    const { exporting, exportHistory } = useExportHistory('ManageDataScreen');

    // The backup value reads the synchronous mirror; re-read on focus so a
    // change made on the Backup screen shows on return.
    const [, setFocusTick] = useState(0);
    useFocusEffect(useCallback(() => setFocusTick((n) => n + 1), []));
    const backupOn = backupCadence() !== 'off' && backupProviderId() !== null;

    const deleteTables = useCallback(async (tableNames: string[]) => {
        await database.write(async () => {
            const batches = await Promise.all(
                tableNames.map(async (table) => {
                    const records = await database.get(table).query(Q.where('id', Q.notEq(''))).fetch();
                    return records.map((r) => r.prepareDestroyPermanently());
                }),
            );
            await database.batch(batches.flat());
        });
    }, []);

    const clear = useCallback(
        async (kind: 'factsTopics' | 'viewingHistory') => {
            const ok = await showDialog({
                title: kind === 'factsTopics' ? t('manageData.clearProfileTitle') : t('manageData.clearHistoryTitle'),
                body: kind === 'factsTopics' ? t('manageData.factsModalDescription') : t('manageData.viewingHistoryModalDescription'),
                confirmLabel: t('common.delete'),
                cancelLabel: t('common.cancel'),
                destructive: true,
            });
            if (!ok) return;
            setIsProcessing(true);
            try {
                if (kind === 'factsTopics') {
                    // Re-anchor the DEV cold-start timeline: this clear is the new t0.
                    coldstartTimeline.arm('cache-clear:factsTopics');
                    await deleteTables(FACTS_AND_TOPICS_TABLES);
                    await useForYouStore.getState().clearData();
                    // The persisted feed order points at now-gone suggestions.
                    useFeedOrderStore.getState().reset();
                    // The orphaned scoring run must be force-cleared before the
                    // re-sync (the clear-feed deadlock), AFTER clearData so its
                    // finished stamp is not nulled.
                    await scoringPipeline.abortRun('cache-clear');
                    if (!useSchedulerStore.getState().isRunning('feed-sync')) {
                        void AppScheduler.trigger('feed-sync');
                    }
                } else {
                    await clearAllVisits();
                }
                toastManager.showSuccess(t('manageData.deletedTitle'), t('manageData.deletedDescription'));
            } catch {
                toastManager.showError(t('manageData.errorTitle'), t('manageData.errorDescription'));
            } finally {
                setIsProcessing(false);
            }
        },
        [deleteTables, t],
    );

    return (
        <View style={{ flex: 1 }}>
            <AbstractGradientBackdrop />
            <View style={{ paddingTop: insets.top }}>
                <DrillDownHeader title={t('you.settings.yourData')} onBack={onBack} />
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingTop: SUBPAGE_TOP_GAP, paddingBottom: insets.bottom + 32 }}>
                <Help>{t('manageData.intro')}</Help>
                <View style={{ height: 12 }} />
                <Group>
                    <Row
                        testID="manage-data-backup"
                        leadingIcon="cloud-upload"
                        title={t('backup.title')}
                        subtitle={t('manageData.backupHint')}
                        value={backupOn ? t('you.settings.on') : t('you.settings.off')}
                        onPress={() => router.push('/logged-in/app_container/you/backup' as Href)}
                    />
                </Group>

                <GroupLabel>{t('manageData.lookAndTake')}</GroupLabel>
                <WhatMeraKeepsCard />
                <Group>
                    <Row
                        testID="manage-data-export"
                        leadingIcon="ios-share"
                        title={t('manageData.exportHistoryTitle')}
                        subtitle={t('manageData.exportHint')}
                        trailing={exporting ? <Spinner size="small" /> : null}
                        onPress={() => void exportHistory()}
                    />
                </Group>

                <GroupLabel>{t('manageData.deleteGroup')}</GroupLabel>
                <Group>
                    <Row
                        testID="manage-data-clear-profile"
                        leadingIcon="psychology"
                        title={t('manageData.clearProfileTitle')}
                        subtitle={t('manageData.clearProfileHint')}
                        trailing={isProcessing ? <Spinner size="small" /> : null}
                        onPress={() => void clear('factsTopics')}
                    />
                    <Row
                        testID="manage-data-clear-history"
                        leadingIcon="history"
                        title={t('manageData.clearHistoryTitle')}
                        subtitle={t('manageData.clearHistoryHint')}
                        onPress={() => void clear('viewingHistory')}
                    />
                </Group>
            </ScrollView>
        </View>
    );
};

export default ManageDataScreen;
