import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { AccountService } from '@/lib/account-service';
import { showDialog } from '@/lib/dialog';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import {
    downloadFailureKind,
    isDownloadInProgress,
    setPromoteWhenDone,
    startModelDownloads,
    useDownloadBytes,
} from '@/lib/mera-protocol-toolkit/core/downloadService';
import { MODEL_CATALOG } from '@/lib/mera-protocol-toolkit/core/model-catalog';
import {
    deleteOnDeviceModels,
    isModelDownloaded,
} from '@/lib/mera-protocol-toolkit/core/modelManager';
import {
    checkRequirements,
    STORAGE_MARGIN_BYTES,
} from '@/lib/mera-protocol-toolkit/core/systemRequirements';
import {
    resetInferenceStats,
    useInferenceStats,
} from '@/lib/mera-protocol-toolkit/core/inference-stats';
import type { SystemRequirementsResult } from '@/lib/mera-protocol-toolkit/types';
import {
    useMeraProtocolStore,
    useModelState as useModelStateSelector,
    useProcessingMode,
    useWebSearchInChat,
} from '@/lib/stores/mera-protocol-store';
import { resolveCurrentUserId } from '@/lib/security/current-user';
import NetInfo from '@react-native-community/netinfo';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    loadBgRefreshToggle,
    saveBgRefreshToggle,
} from '@/lib/background/bg-refresh-ui';

/** Decimal gigabytes with one place, the way the catalogue sizes read. */
export const gbText = (bytes: number): string => (bytes / 1e9).toFixed(1);

export function useMeraProtocolSettings() {
    const { t } = useTranslation();
    const [isLoading, setIsLoading] = useState(true);
    const [isUpdatingMode, setIsUpdatingMode] = useState(false);
    const [requirementsResult, setRequirementsResult] = useState<SystemRequirementsResult | null>(null);
    const [showRequirements, setShowRequirements] = useState(false);
    const [isDeletingModel, setIsDeletingModel] = useState(false);
    // Which catalogue models are on disk, by id.
    const [onDisk, setOnDisk] = useState<Record<string, boolean>>({});

    const processingMode = useProcessingMode();
    const isOnDevice = processingMode === ProcessingMode.OnDevice;
    const modelState = useModelStateSelector();
    const store = useMeraProtocolStore();
    const webSearchInChat = useWebSearchInChat();
    const inferenceStats = useInferenceStats();
    const downloadBytes = useDownloadBytes();

    const toast = useToast();

    const missing = MODEL_CATALOG.filter((m) => !onDisk[m.modelId]);
    const missingBytes = missing.reduce((sum, m) => sum + m.sizeBytes, 0);
    const bothOnDisk = missing.length === 0;
    const anyOnDisk = MODEL_CATALOG.some((m) => onDisk[m.modelId]);
    const onDiskBytes = MODEL_CATALOG.filter((m) => onDisk[m.modelId]).reduce((sum, m) => sum + m.sizeBytes, 0);
    const isDownloading = modelState === 'downloading';

    // A storage-only failure is not "this phone can't run it": On this phone stays
    // selectable and only Download is blocked.
    const storageShort = requirementsResult?.failedCheck === 'storage';
    const deviceSupported = requirementsResult ? requirementsResult.supported || storageShort : null;
    const onDeviceAvailable = deviceSupported !== false && bothOnDisk;

    // GB the reader must free: what the download needs (plus the margin) less what is free.
    const freeGb = requirementsResult?.deviceInfo.freeStorageGB ?? null;
    const shortfallBytes =
        freeGb == null ? missingBytes : Math.max(0, missingBytes + STORAGE_MARGIN_BYTES - freeGb * 1e9);
    const freeUpSize = `${(Math.max(1, Math.ceil(shortfallBytes / 1e8)) / 10).toFixed(1)} GB`;

    const failureKind = modelState === 'error' ? downloadFailureKind(store.modelError ?? '') : null;

    // Drives which sections are visible. The user can express intent to run
    // on-device even when the runtime preconditions (device + both models) aren't
    // met yet. `processingMode` only flips to OnDevice once on-device is runnable.
    const [onDeviceIntent, setOnDeviceIntent] = useState(
        processingMode === ProcessingMode.OnDevice,
    );

    const refreshDisk = useCallback(async () => {
        const entries = await Promise.all(
            MODEL_CATALOG.map(async (m) => [m.modelId, await isModelDownloaded(m.modelId).catch(() => false)] as const),
        );
        const next = Object.fromEntries(entries);
        setOnDisk(next);
        return next;
    }, []);

    // The requirement check counts the storage the download still needs. Not while
    // a download runs (free space is falling by design).
    useEffect(() => {
        if (isDownloading) return;
        let alive = true;
        void checkRequirements({ bytesToDownload: missingBytes }).then((r) => {
            if (alive) setRequirementsResult(r);
        });
        return () => {
            alive = false;
        };
    }, [missingBytes, isDownloading]);

    // A download that ends (or is cancelled) changes what is on disk.
    useEffect(() => {
        if (modelState === 'downloaded' || modelState === 'not_downloaded' || modelState === 'error') {
            void refreshDisk();
        }
    }, [modelState, refreshDisk]);

    // Background refresh (the `mera-background` OS task). Default ON; read from
    // settings, not a store, because the OS task reads the same row.
    const [bgRefreshEnabled, setBgRefreshEnabled] = useState(true);
    useEffect(() => {
        let alive = true;
        void loadBgRefreshToggle().then((enabled) => {
            if (alive) setBgRefreshEnabled(enabled);
        });
        return () => {
            alive = false;
        };
    }, []);
    const toggleBgRefresh = useCallback(() => {
        const next = !bgRefreshEnabled;
        setBgRefreshEnabled(next);
        saveBgRefreshToggle(next).catch(() => {
            // The save failed, so the switch goes back to what is stored.
            setBgRefreshEnabled(!next);
        });
    }, [bgRefreshEnabled]);

    useEffect(() => {
        loadSettings();
        // Mount-time load; the loader is stable and excluded on purpose.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const loadSettings = async () => {
        try {
            const userId = await resolveCurrentUserId();
            const userPersona = await AccountService.getUserPersona(userId);
            const disk = await refreshDisk();
            const allOnDisk = MODEL_CATALOG.every((m) => disk[m.modelId]);
            if (userPersona?.processingMode) {
                const wantsOnDevice = userPersona.processingMode === ProcessingMode.OnDevice;
                setOnDeviceIntent(wantsOnDevice);
                // Never promote OnDevice without both files on disk (a retired model,
                // or one the OS evicted from Caches). Keep the intent so the download
                // section shows; the download promotes once it lands.
                const runnable = !wantsOnDevice || allOnDisk;
                store.setProcessingMode(runnable ? userPersona.processingMode : ProcessingMode.Cloud);
            }
            if (!isDownloadInProgress()) store.setModelState(allOnDisk ? 'downloaded' : 'not_downloaded');
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('meraProtocol.loadFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('meraProtocol.loadFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsLoading(false);
        }
    };

    const selectMode = async (mode: ProcessingMode) => {
        const wantsOnDevice = mode === ProcessingMode.OnDevice;

        // Always reflect intent locally: it drives the help line and the download button.
        setOnDeviceIntent(wantsOnDevice);
        // A download in flight follows the reader's latest choice.
        if (!wantsOnDevice || isDownloadInProgress()) setPromoteWhenDone(wantsOnDevice);

        // If on-device isn't runnable yet, the contextual UI we just revealed
        // is the feedback. Don't persist or toast.
        if (wantsOnDevice && !onDeviceAvailable) return;
        if (mode === processingMode) return;

        setIsUpdatingMode(true);
        try {
            const userId = await resolveCurrentUserId();
            await AccountService.updateProcessingMode(userId, mode);
            store.setProcessingMode(mode);

            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>
                            {wantsOnDevice
                                ? t('meraProtocol.modeUpdatedOnDeviceTitle')
                                : t('meraProtocol.modeUpdatedCloudTitle')}
                        </ToastTitle>
                        <ToastDescription>
                            {wantsOnDevice
                                ? t('meraProtocol.modeUpdatedOnDeviceDescription')
                                : t('meraProtocol.modeUpdatedCloudDescription')}
                        </ToastDescription>
                    </Toast>
                ),
            });
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('meraProtocol.settingUpdateFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('meraProtocol.settingUpdateFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsUpdatingMode(false);
        }
    };

    // One download for whatever is still missing. The toolkit promotes to OnDevice
    // when both files land, if the reader's intent says so.
    const handleDownload = useCallback(async () => {
        if (isDownloadInProgress()) return;
        const net = await NetInfo.fetch().catch(() => null);
        if (net?.type === 'cellular') {
            const ok = await showDialog({
                title: t('meraProtocol.cellularTitle'),
                body: t('meraProtocol.cellularBody', { size: `${gbText(missingBytes)} GB` }),
                confirmLabel: t('meraProtocol.cellularConfirm'),
                cancelLabel: t('meraProtocol.cellularWait'),
            });
            if (!ok) return;
        }
        startModelDownloads({ promote: onDeviceIntent });
    }, [missingBytes, onDeviceIntent, t]);

    // The models the reader relied on are leaving the phone, so processing falls
    // back to cloud, locally and on the server, BEFORE the files go.
    const fallBackToCloud = useCallback(async () => {
        if (useMeraProtocolStore.getState().processingMode !== ProcessingMode.OnDevice) return;
        try {
            const userId = await resolveCurrentUserId();
            await AccountService.updateProcessingMode(userId, ProcessingMode.Cloud);
        } catch {
            // Server mutation failed. Still update locally so the UI reflects
            // reality; the next settings load will not re-promote OnDevice
            // without both models on disk.
        }
        useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.Cloud);
    }, []);

    const handleDeleteModels = useCallback(async () => {
        const ok = await showDialog({
            title: t('meraProtocol.deleteModelsTitle'),
            body: t('meraProtocol.deleteModelsBody', { size: `${gbText(onDiskBytes)} GB` }),
            confirmLabel: t('common.delete'),
            cancelLabel: t('common.cancel'),
            destructive: true,
        });
        if (!ok) return;
        setIsDeletingModel(true);
        try {
            await fallBackToCloud();
            // Also clear on-device intent so the download section follows suit.
            setOnDeviceIntent(false);
            setPromoteWhenDone(false);
            await deleteOnDeviceModels();
            store.setModelState('not_downloaded');
            store.setDownloadProgress(0);
            resetInferenceStats();
            await refreshDisk();
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('meraProtocol.deleteFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('meraProtocol.deleteFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsDeletingModel(false);
        }
        // `store` is a stable singleton ref.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onDiskBytes, fallBackToCloud, refreshDisk, toast, t]);

    return {
        isLoading,
        isUpdatingMode,
        requirementsResult,
        showRequirements,
        setShowRequirements,
        isDeletingModel,
        processingMode,
        isOnDevice,
        store,
        webSearchInChat,
        inferenceStats,
        deviceSupported,
        onDeviceIntent,
        bgRefreshEnabled,
        toggleBgRefresh,
        selectMode,
        onDisk,
        missingBytes,
        bothOnDisk,
        anyOnDisk,
        isDownloading,
        downloadBytes,
        failureKind,
        storageShort,
        freeUpSize,
        handleDownload,
        handleDeleteModels,
    };
}
