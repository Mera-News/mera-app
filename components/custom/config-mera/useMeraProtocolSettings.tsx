import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { AccountService } from '@/lib/account-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import {
    isDownloadInProgress,
    startModelDownloads,
} from '@/lib/mera-protocol-toolkit/core/downloadService';
import {
    deleteBaseModel,
    disposeModel,
    isModelDownloaded,
} from '@/lib/mera-protocol-toolkit/core/modelManager';
import { checkRequirements } from '@/lib/mera-protocol-toolkit/core/systemRequirements';
import {
    TEXT_MODEL,
    type ModelCatalogEntry,
} from '@/lib/mera-protocol-toolkit/core/model-catalog';
import {
    resetInferenceStats,
    useInferenceStats,
} from '@/lib/mera-protocol-toolkit/core/inference-stats';
import type { SystemRequirementsResult } from '@/lib/mera-protocol-toolkit/types';
import {
    useDownloadProgress,
    useMeraProtocolStore,
    useModelState as useModelStateSelector,
    useProcessingMode,
    useSelectedModelId,
    useWebSearchInChat,
} from '@/lib/stores/mera-protocol-store';
import { resolveCurrentUserId } from '@/lib/security/current-user';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useColors } from '@/lib/theme/tokens';
import {
    loadBgRefreshToggle,
    saveBgRefreshToggle,
} from '@/lib/background/bg-refresh-ui';


export function useMeraProtocolSettings() {
    const { t } = useTranslation();
    const colors = useColors();
    const [isLoading, setIsLoading] = useState(true);
    const [isUpdatingMode, setIsUpdatingMode] = useState(false);
    const [requirementsResult, setRequirementsResult] = useState<SystemRequirementsResult | null>(null);
    const [showRequirements, setShowRequirements] = useState(false);
    const [showDeleteModelConfirm, setShowDeleteModelConfirm] = useState(false);
    const [isDeletingModel, setIsDeletingModel] = useState(false);
    const [isSwitchingModel, setIsSwitchingModel] = useState(false);
    // The catalogue entry the user tapped while another model is on disk.
    const [pendingSwitchTo, setPendingSwitchTo] = useState<ModelCatalogEntry | null>(null);

    const processingMode = useProcessingMode();
    const isOnDevice = processingMode === ProcessingMode.OnDevice;
    const selectedModelId = useSelectedModelId();
    const modelState = useModelStateSelector();
    const downloadProgress = useDownloadProgress();
    const store = useMeraProtocolStore();
    const webSearchInChat = useWebSearchInChat();

    const currentModel = TEXT_MODEL;
    const inferenceStats = useInferenceStats();
    const modelDownloaded = modelState === 'downloaded' || modelState === 'ready';

    const toast = useToast();

    const deviceSupported = requirementsResult?.supported ?? null;
    const onDeviceAvailable = deviceSupported !== false && modelDownloaded;

    // Drives which sections are visible. The user can express intent to run
    // on-device even when the runtime preconditions (device + model) aren't
    // met yet — that's what reveals the relevant banner / download UI.
    // `processingMode` only flips to OnDevice once on-device is actually runnable.
    const [onDeviceIntent, setOnDeviceIntent] = useState(
        processingMode === ProcessingMode.OnDevice,
    );

    useEffect(() => {
        checkRequirements().then(setRequirementsResult);
    }, []);

    // Once the user has expressed intent to run on-device AND the runtime
    // preconditions are met (device supported + model downloaded), promote
    // their intent into the persisted processingMode. This lets the user
    // tap "On-device" once, download the model, and have it Just Work.
    useEffect(() => {
        if (!onDeviceIntent) return;
        if (processingMode === ProcessingMode.OnDevice) return;
        if (deviceSupported !== true) return;
        if (!modelDownloaded) return;

        (async () => {
            try {
                const userId = await resolveCurrentUserId();
                await AccountService.updateProcessingMode(userId, ProcessingMode.OnDevice);
                store.setProcessingMode(ProcessingMode.OnDevice);
            } catch {
                // Server mutation failed — leave processingMode as-is. The user
                // can retry by tapping the on-device pill again.
            }
        })();
        // Reacts only to the intent/capability inputs listed; `store` and the
        // async helpers it calls are stable module/singleton refs, excluded
        // intentionally to avoid re-running the mutation on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onDeviceIntent, deviceSupported, modelDownloaded, processingMode]);

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

    const checkModelStatus = async () => {
        if (isDownloadInProgress()) return;
        try {
            const downloaded = await isModelDownloaded(selectedModelId);
            store.setModelState(downloaded ? 'downloaded' : 'not_downloaded');
        } catch {
            store.setModelState('not_downloaded');
        }
    };

    const loadSettings = async () => {
        try {
            const userId = await resolveCurrentUserId();
            const userPersona = await AccountService.getUserPersona(userId);
            if (userPersona?.processingMode) {
                const wantsOnDevice = userPersona.processingMode === ProcessingMode.OnDevice;
                setOnDeviceIntent(wantsOnDevice);
                // Never promote OnDevice without a model on disk (a retired model,
                // or one the OS evicted from Caches). Keep the intent so the picker
                // shows; the auto-promote effect flips the mode once a download
                // finishes.
                const runnable = !wantsOnDevice || (await isModelDownloaded(selectedModelId));
                store.setProcessingMode(runnable ? userPersona.processingMode : ProcessingMode.Cloud);
            }
            await checkModelStatus();
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

        // Always reflect intent locally — this is what drives the visibility
        // of the device-compatibility banner and the model-download section.
        setOnDeviceIntent(wantsOnDevice);

        // If on-device isn't runnable yet, the contextual UI we just revealed
        // (banner or download section) is the feedback. Don't persist or toast.
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

    // Show toasts for download completion/failure while on this screen
    useEffect(() => {
        let prev = useMeraProtocolStore.getState().modelState;
        const unsub = useMeraProtocolStore.subscribe((state) => {
            const curr = state.modelState;
            if (prev === 'downloading' && curr === 'downloaded') {
                toast.show({
                    placement: 'top',
                    render: () => (
                        <Toast action="success" variant="solid">
                            <ToastTitle>{t('meraProtocol.dlCompleteTitle')}</ToastTitle>
                            <ToastDescription>{t('meraProtocol.dlCompleteDescription')}</ToastDescription>
                        </Toast>
                    ),
                });
            }
            if (prev === 'downloading' && curr === 'error') {
                toast.show({
                    placement: 'top',
                    render: () => (
                        <Toast action="error" variant="solid">
                            <ToastTitle>{t('meraProtocol.dlFailedTitle')}</ToastTitle>
                            <ToastDescription>{t('meraProtocol.dlFailedDescription')}</ToastDescription>
                        </Toast>
                    ),
                });
            }
            prev = curr;
        });
        return unsub;
    }, [toast, t]);

    const handleDownloadModel = useCallback(() => {
        if (isDownloadInProgress()) {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="info" variant="solid">
                        <ToastTitle>{t('meraProtocol.dlInProgressTitle')}</ToastTitle>
                        <ToastDescription>{t('meraProtocol.dlInProgressDescription')}</ToastDescription>
                    </Toast>
                ),
            });
            return;
        }
        startModelDownloads({ promote: onDeviceIntent });
        toast.show({
            placement: 'top',
            render: () => (
                <Toast action="info" variant="solid">
                    <ToastTitle>{t('meraProtocol.dlStartedTitle')}</ToastTitle>
                    <ToastDescription>{t('meraProtocol.dlStartedDescription')}</ToastDescription>
                </Toast>
            ),
        });
    }, [toast, onDeviceIntent, t]);

    const handleDeleteModel = useCallback(() => {
        setShowDeleteModelConfirm(true);
    }, []);

    // The model the user relied on is leaving the device, so on-device processing
    // falls back to cloud until a new one lands.
    const fallBackToCloud = useCallback(async () => {
        if (processingMode !== ProcessingMode.OnDevice) return;
        try {
            const userId = await resolveCurrentUserId();
            await AccountService.updateProcessingMode(userId, ProcessingMode.Cloud);
        } catch {
            // Server mutation failed. Still update locally so the UI reflects
            // reality; the next settings load will not re-promote OnDevice
            // without a model on disk.
        }
        store.setProcessingMode(ProcessingMode.Cloud);
        // Reacts only to the inputs listed; `store` and the async helpers are
        // stable module/singleton refs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [processingMode]);

    const confirmDeleteModel = useCallback(async () => {
        setIsDeletingModel(true);
        setShowDeleteModelConfirm(false);
        try {
            await disposeModel();
            await deleteBaseModel(selectedModelId);
            store.setModelState('not_downloaded');
            store.setDownloadProgress(0);

            await fallBackToCloud();
            // Also clear on-device intent so the download section collapses.
            setOnDeviceIntent(false);

            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>{t('meraProtocol.modelDeletedTitle')}</ToastTitle>
                        <ToastDescription>{t('meraProtocol.modelDeletedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
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
    }, [store, toast, selectedModelId, t, fallBackToCloud]);

    const selectModel = useCallback((entry: ModelCatalogEntry) => {
        if (entry.modelId === selectedModelId) return;
        if (modelState === 'downloading' || isSwitchingModel) return;
        // Only one model is ever on disk, so switching away from a downloaded
        // one deletes it. That is worth a confirm; picking before any download
        // is not.
        if (modelState === 'downloaded' || modelState === 'ready' || modelState === 'loading') {
            setPendingSwitchTo(entry);
            return;
        }
        store.setSelectedModelId(entry.modelId);
        store.setModelState('not_downloaded');
        store.setDownloadProgress(0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedModelId, modelState, isSwitchingModel]);

    const confirmSwitchModel = useCallback(async () => {
        const target = pendingSwitchTo;
        setPendingSwitchTo(null);
        if (!target) return;
        setIsSwitchingModel(true);
        try {
            await disposeModel();
            await deleteBaseModel(selectedModelId);
            store.setSelectedModelId(target.modelId);
            store.setModelState('not_downloaded');
            store.setDownloadProgress(0);
            resetInferenceStats();
            await fallBackToCloud();
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
            setIsSwitchingModel(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingSwitchTo, selectedModelId, fallBackToCloud, toast, t]);

    const getModelStatusText = (): string => {
        switch (modelState) {
            case 'not_downloaded':
                return t('meraProtocol.notDownloaded');
            case 'downloading':
                return downloadProgress > 0
                    ? t('meraProtocol.downloading', { percent: Math.round(downloadProgress) })
                    : t('meraProtocol.starting');
            case 'downloaded':
                return t('meraProtocol.downloaded');
            case 'loading':
                return t('meraProtocol.loadingMemory');
            case 'ready':
                return t('meraProtocol.loaded');
            case 'error':
                return t('meraProtocol.errorOccurred');
            default:
                return t('meraProtocol.unknown');
        }
    };

    const getModelStatusColor = (): string => {
        switch (modelState) {
            case 'ready':
            case 'downloaded':
                return colors.positive;
            case 'downloading':
            case 'loading':
                return colors.warning;
            case 'error':
                return colors.negative;
            default:
                return colors.ink2;
        }
    };

    return {
        isLoading,
        isUpdatingMode,
        requirementsResult,
        showRequirements,
        setShowRequirements,
        showDeleteModelConfirm,
        setShowDeleteModelConfirm,
        isDeletingModel,
        isSwitchingModel,
        pendingSwitchTo,
        setPendingSwitchTo,
        processingMode,
        isOnDevice,
        selectedModelId,
        modelState,
        downloadProgress,
        store,
        webSearchInChat,
        currentModel,
        inferenceStats,
        deviceSupported,
        onDeviceIntent,
        bgRefreshEnabled,
        toggleBgRefresh,
        handleDownloadModel,
        handleDeleteModel,
        confirmDeleteModel,
        confirmSwitchModel,
        selectModel,
        getModelStatusText,
        getModelStatusColor,
        selectMode,
    };
}
