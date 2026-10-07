import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import WhatMeraKeepsCard from '@/components/custom/config-mera/WhatMeraKeepsCard';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { Group, GroupLabel, Help, Row } from '@/components/custom/you/rows';
import { Spinner } from '@/components/ui/spinner';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { authClient, clearAuthStorage } from '@/lib/auth-client';
import { backupCadence, backupProviderId } from '@/lib/backup/backup-settings';
import database from '@/lib/database';
import { clearAllVisits } from '@/lib/database/services/publication-visit-service';
import { clearDeviceAuthCredentials } from '@/lib/device-auth';
import * as coldstartTimeline from '@/lib/diagnostics/coldstart-timeline';
import { showDialog } from '@/lib/dialog';
import logger from '@/lib/logger';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import * as scoringPipeline from '@/lib/services/scoring-pipeline';
import { clearAllStores, useForYouStore } from '@/lib/stores';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useUIStore } from '@/lib/stores/ui-store';
import { useColors } from '@/lib/theme/tokens';
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
 * history), then Delete (Clear profile, Clear reading history, and Delete
 * account last, in red, asking twice). No "Clear article cache" (it clears
 * itself) and no "Wipe all" (owner Y10).
 */
const ManageDataScreen: React.FC<ManageDataScreenProps> = ({ onBack }) => {
    const insets = useSafeAreaInsets();
    const toast = useToast();
    const { t } = useTranslation();
    const colors = useColors();
    const [isProcessing, setIsProcessing] = useState(false);
    const { closeModal, setModalProcessing } = useUIStore();
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

    const handleDeleteAccount = useCallback(async () => {
        let serverDeleteSucceeded = false;
        try {
            setModalProcessing('deleteAccount', true);
            closeModal('deleteAccount');

            // authClient.deleteUser() now 404s unconditionally — the server has
            // replaced immediate deletion with a 30-day grace period. `$fetch`
            // resolves `{ data, error }` rather than throwing on a non-2xx
            // response, so success must be read from `error` being absent, not
            // from the call merely completing.
            const { error } = await authClient.$fetch('/request-account-deletion', {
                method: 'POST',
            });
            if (error) throw error;
            serverDeleteSucceeded = true;

            // Local cleanup after the server accepted the deletion. Each step
            // runs on its own, so one failing (a keychain hiccup, a sign-out
            // that throws) cannot skip the steps after it, and each failure is
            // reported by name rather than swallowed.
            const cleanupStep = async (step: string, run: () => Promise<void> | void) => {
                try {
                    await run();
                } catch (error) {
                    logger.captureException(error, {
                        tags: { component: 'ManageDataScreen', method: 'deleteAccount', step },
                    });
                }
            };
            // clearAuthStorage() owns the (guarded, bounded) server sign-out,
            // see its header. A direct signOut here once let a network failure
            // skip the whole local cleanup silently.
            await cleanupStep('sign-out', () => clearAuthStorage());
            // DELETION SEVERS the device binding (S10). Logout preserves it so
            // login resumes the account; deletion must not. The server deletes
            // the device record too, so this is the client half.
            await cleanupStep('device-credentials', () => clearDeviceAuthCredentials());
            await cleanupStep('route', () => {
                router.dismissAll();
                // The LOGOUT route, not '/': the launch gate counts the
                // still-stale better-auth session atom as identity and
                // re-entered the app with a dead session (BUG 4). signedOut
                // suppresses login.tsx's mirror-image shortcut until the atom
                // actually clears.
                router.replace({ pathname: '/login', params: { signedOut: '1' } });
            });
            await new Promise((resolve) => setTimeout(resolve, 0));
            await cleanupStep('stores', () => clearAllStores());

            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>{t('preferences.accountDeletionScheduledTitle')}</ToastTitle>
                        <ToastDescription>{t('preferences.accountDeletionScheduledDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } catch {
            if (!serverDeleteSucceeded) {
                toast.show({
                    placement: 'top',
                    render: () => (
                        <Toast action="error" variant="solid">
                            <ToastTitle>{t('preferences.deletionFailedTitle')}</ToastTitle>
                            <ToastDescription>{t('preferences.deletionFailedDescription')}</ToastDescription>
                        </Toast>
                    ),
                });
            }
        } finally {
            setModalProcessing('deleteAccount', false);
        }
    }, [closeModal, setModalProcessing, toast, t]);

    // Delete account asks twice before it does anything (App Store 5.1.1(v)).
    const confirmDeleteAccount = useCallback(async () => {
        const first = await showDialog({
            title: t('preferences.deleteAccount'),
            body: t('preferences.deleteAccountConfirmGrace'),
            warning: t('preferences.deleteAccountWarningGrace'),
            confirmLabel: t('preferences.continue'),
            cancelLabel: t('common.cancel'),
            destructive: true,
        });
        if (!first) return;
        const second = await showDialog({
            title: t('preferences.finalConfirmation'),
            body: t('preferences.finalConfirmationBodyGrace'),
            warning: t('preferences.absolutelySure'),
            confirmLabel: t('preferences.yesDeleteAccount'),
            cancelLabel: t('common.cancel'),
            destructive: true,
        });
        if (second) await handleDeleteAccount();
    }, [handleDeleteAccount, t]);

    return (
        <View style={{ flex: 1 }}>
            <AbstractGradientBackdrop />
            <View style={{ paddingTop: insets.top }}>
                <DrillDownHeader title={t('you.settings.yourData')} onBack={onBack} />
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: insets.bottom + 32 }}>
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
                    <Row
                        testID="manage-data-delete-account"
                        leadingIcon="delete-forever"
                        title={t('preferences.deleteAccount')}
                        titleColor={colors.negative}
                        subtitle={t('manageData.deleteAccountHint')}
                        onPress={() => void confirmDeleteAccount()}
                    />
                </Group>
            </ScrollView>
        </View>
    );
};

export default ManageDataScreen;
