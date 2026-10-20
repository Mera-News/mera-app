import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { AccountService } from '@/lib/account-service';
import { showDialog } from '@/lib/dialog';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import {
    downloadFailureKind,
    isDownloadInProgress,
    onDeviceModelsStatus,
    promoteToOnDevice,
    setPromoteWhenDone,
    startModelDownloads,
    useDownloadBytes,
    willPromoteWhenDone,
} from '@/lib/mera-protocol-toolkit/core/downloadService';
import { deleteOnDeviceModels } from '@/lib/mera-protocol-toolkit/core/modelManager';
import {
    builtInAvailability,
    setTextEngine,
    useTextEngine,
    getTextEngine,
    isBuiltInEngine,
    type TextEngine,
} from '@/lib/mera-protocol-toolkit/core/text-engine';
import type { OnDeviceLlmAvailability } from '@/modules/mera-on-device-llm';
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
import { useUserStore } from '@/lib/stores/user-store';
import { resolveCurrentUserId } from '@/lib/security/current-user';
import NetInfo from '@react-native-community/netinfo';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
    loadBgRefreshToggle,
    saveBgRefreshToggle,
} from '@/lib/background/bg-refresh-ui';

/** Decimal gigabytes with one place, the way the catalogue sizes read. */
export const gbText = (bytes: number): string => (bytes / 1e9).toFixed(1);

/**
 * Why Apple Intelligence cannot be picked, by availability code. `unsupportedPlatform`
 * has no line: the whole Chat and notes group is hidden there. Copy never names a model.
 */
export const NATIVE_REASON_KEYS = {
    deviceNotEligible: 'meraProtocol.nativeDeviceNotEligible',
    appleIntelligenceNotEnabled: 'meraProtocol.nativeNotEnabled',
    modelNotReady: 'meraProtocol.nativeNotReady',
    appLanguageNotSupported: 'meraProtocol.nativeAppLanguage',
    deviceLanguageNotSupported: 'meraProtocol.nativeDeviceLanguage',
    osTooOld: 'meraProtocol.nativeOsTooOld',
    needsSystemUpdate: 'meraProtocol.nativeUnknown',
    unknown: 'meraProtocol.nativeUnknown',
} as const;

/** Every key the models section and the engine group can show, for the no-model-names test. */
export const MODELS_SECTION_KEYS = [
    'meraProtocol.modelsTitle',
    'meraProtocol.modelsHelp',
    'meraProtocol.modelsWaitingNative',
    'meraProtocol.modelsRowTitle',
    'meraProtocol.modelsRowSubtitle',
    'meraProtocol.modelRowReady',
    'meraProtocol.modelRowMissing',
    'meraProtocol.modelLicenseLink',
    'meraProtocol.downloadAction',
    'meraProtocol.downloadingOf',
    'meraProtocol.cancelDownloadAction',
    'meraProtocol.tryAgain',
    'meraProtocol.deleteModelsLabel',
    'meraProtocol.deleteModelsTitle',
    'meraProtocol.deleteModelsBody',
    'meraProtocol.cellularTitle',
    'meraProtocol.cellularBody',
    'meraProtocol.cellularConfirm',
    'meraProtocol.cellularWait',
    'meraProtocol.freeUpToDownload',
    'meraProtocol.errorFinish',
    'meraProtocol.errorFile',
    'meraProtocol.errorSpace',
    'meraProtocol.chatNotesTitle',
    'meraProtocol.engineMera',
    'meraProtocol.engineApple',
    'meraProtocol.speedTitle',
    'meraProtocol.speedLoad',
    'meraProtocol.speedGeneration',
    'meraProtocol.speedRanking',
    'meraProtocol.speedNotes',
    'meraProtocol.speedRefused',
    'meraProtocol.speedResetNote',
    'download.onDeviceReady',
    ...Object.values(NATIVE_REASON_KEYS),
] as const;

/** Keeps the cached server persona in step with a mode the server just accepted (the boot purge reads it). */
function cacheProcessingMode(mode: ProcessingMode): void {
    const persona = useUserStore.getState().userPersona;
    if (persona) useUserStore.getState().setUserPersona({ ...persona, processingMode: mode });
}

type ModelsStatus = { missingBytes: number; onDiskBytes: number; runnable: boolean };

export function useMeraProtocolSettings() {
    const { t } = useTranslation();
    const [isLoading, setIsLoading] = useState(true);
    const [isUpdatingMode, setIsUpdatingMode] = useState(false);
    const [requirementsResult, setRequirementsResult] = useState<SystemRequirementsResult | null>(null);
    const [showRequirements, setShowRequirements] = useState(false);
    const [isDeletingModel, setIsDeletingModel] = useState(false);
    // What the chosen engine still needs, what is on disk, and whether On this phone can run.
    const [status, setStatus] = useState<ModelsStatus | null>(null);
    // Apple Intelligence availability, re-read on every focus (it can change while the app runs).
    const [native, setNative] = useState<OnDeviceLlmAvailability | null>(null);
    const textEngine = useTextEngine();

    const processingMode = useProcessingMode();
    const isOnDevice = processingMode === ProcessingMode.OnDevice;
    const modelState = useModelStateSelector();
    const store = useMeraProtocolStore();
    const webSearchInChat = useWebSearchInChat();
    const inferenceStats = useInferenceStats();
    const downloadBytes = useDownloadBytes();

    const toast = useToast();

    const missingBytes = status?.missingBytes ?? 0;
    const onDiskBytes = status?.onDiskBytes ?? 0;
    const runnable = status?.runnable ?? false;
    // One row, one size: what is still to download, else what the files take.
    const modelsSizeBytes = missingBytes > 0 ? missingBytes : onDiskBytes;
    // The engine group is iOS only: Android reports unsupportedPlatform.
    const showEngineGroup = native != null && native.reason !== 'unsupportedPlatform';
    const nativeReasonKey =
        native && !native.available && native.reason && native.reason !== 'unsupportedPlatform'
            ? NATIVE_REASON_KEYS[native.reason]
            : null;
    const isDownloading = modelState === 'downloading';

    // A storage-only failure is not "this phone can't run it": On this phone stays
    // selectable and only Download is blocked.
    const storageShort = requirementsResult?.failedCheck === 'storage';
    const deviceSupported = requirementsResult ? requirementsResult.supported || storageShort : null;
    const onDeviceAvailable = deviceSupported !== false && runnable;

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

    const intentRef = useRef(onDeviceIntent);
    useEffect(() => {
        intentRef.current = onDeviceIntent;
    }, [onDeviceIntent]);
    // Set for the whole delete: nothing may promote the phone while its files are being removed.
    const deletingRef = useRef(false);

    // Apple Intelligence is the chosen engine, nothing is left to download and it cannot run yet.
    // Without a line the section would show files on disk and no way forward.
    const waitingForNative =
        onDeviceIntent && status != null && isBuiltInEngine(textEngine) && !runnable && missingBytes === 0;

    // Reads what is on disk and whether Apple Intelligence can be used. Pure: changes no mode.
    const readStatus = useCallback(async () => {
        const [next, availability] = await Promise.all([
            onDeviceModelsStatus(),
            builtInAvailability().catch(
                (): OnDeviceLlmAvailability => ({ available: false, reason: 'unsupportedPlatform' }),
            ),
        ]);
        setStatus(next);
        setNative(availability);
        return next;
    }, []);

    // While the reader wants On this phone, the phone follows what can run: it moves to On this phone
    // when it can, else falls back to Private cloud on this phone only (the server persona and the
    // intent are kept). A running download promotes by itself when it lands.
    const applyIntent = useCallback(async (next: ModelsStatus) => {
        if (!intentRef.current || deletingRef.current || isDownloadInProgress()) return;
        const current = useMeraProtocolStore.getState().processingMode;
        if (next.runnable) {
            if (current !== ProcessingMode.OnDevice) await promoteToOnDevice();
        } else if (current === ProcessingMode.OnDevice) {
            useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.Cloud);
        }
    }, []);

    // Fresh on screen focus, when the app returns to the foreground (Apple Intelligence can be
    // switched on in iOS Settings) and after an engine switch.
    const refresh = useCallback(async () => {
        const next = await readStatus();
        await applyIntent(next);
        return next;
    }, [readStatus, applyIntent]);

    useEffect(() => {
        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'active') void refresh();
        });
        return () => sub.remove();
    }, [refresh]);

    useEffect(() => {
        void getTextEngine();
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
            void readStatus();
        }
    }, [modelState, readStatus]);

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
            const { runnable: canRun } = await readStatus();
            if (userPersona?.processingMode) {
                const wantsOnDevice = userPersona.processingMode === ProcessingMode.OnDevice;
                // A download started with the on-device intent is still that intent, even though the
                // server says Cloud until the pair lands and the download promotes the phone.
                setOnDeviceIntent(wantsOnDevice || willPromoteWhenDone());
                // Never promote OnDevice before it can run (a retired model, or one the OS
                // evicted from Caches). Keep the intent so the download section shows; the
                // download promotes once it lands.
                const ok = !wantsOnDevice || canRun;
                store.setProcessingMode(ok ? userPersona.processingMode : ProcessingMode.Cloud);
            }
            if (!isDownloadInProgress()) store.setModelState(canRun ? 'downloaded' : 'not_downloaded');
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
        // The intent mirrors the server persona. Read it before it is overwritten below: the local mode
        // is already Private cloud in the split state (server on-device, files missing), so comparing
        // against it would never write the reader's choice to the server.
        const hadIntent = intentRef.current;

        // Always reflect intent locally: it drives the help line and the download button.
        setOnDeviceIntent(wantsOnDevice);
        // A download in flight follows the reader's latest choice.
        if (!wantsOnDevice || isDownloadInProgress()) setPromoteWhenDone(wantsOnDevice);

        // If on-device isn't runnable yet, the contextual UI we just revealed
        // is the feedback. Don't persist or toast.
        if (wantsOnDevice && !onDeviceAvailable) return;
        if (mode === processingMode && wantsOnDevice === hadIntent) return;

        setIsUpdatingMode(true);
        try {
            const userId = await resolveCurrentUserId();
            await AccountService.updateProcessingMode(userId, mode);
            store.setProcessingMode(mode);
            cacheProcessingMode(mode);

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
            // The server still holds what it held: the intent goes back with it.
            setOnDeviceIntent(hadIntent);
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

    // The text engine for chat and notes. refresh() applies the On this phone intent to it.
    const selectEngine = useCallback(
        async (engine: TextEngine) => {
            if (engine === textEngine) return;
            await setTextEngine(engine);
            // The figures are the previous engine's: start clean rather than mix them in.
            resetInferenceStats();
            await refresh();
        },
        [textEngine, refresh],
    );

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
    // back to cloud, locally and on the server, BEFORE the files go. The server write follows
    // the intent, not the local mode: the local mode is already Cloud when the models cannot run.
    const fallBackToCloud = useCallback(async () => {
        if (useMeraProtocolStore.getState().processingMode !== ProcessingMode.OnDevice && !onDeviceIntent) return;
        try {
            const userId = await resolveCurrentUserId();
            await AccountService.updateProcessingMode(userId, ProcessingMode.Cloud);
            cacheProcessingMode(ProcessingMode.Cloud);
        } catch {
            // Server mutation failed. Still update locally so the UI reflects
            // reality; the next settings load will not re-promote OnDevice
            // without both models on disk.
        }
        useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.Cloud);
    }, [onDeviceIntent]);

    const handleDeleteModels = useCallback(async () => {
        const ok = await showDialog({
            title: t('meraProtocol.deleteModelsTitle'),
            body: t('meraProtocol.deleteModelsBody', { size: `${gbText(onDiskBytes)} GB` }),
            confirmLabel: t('common.delete'),
            cancelLabel: t('common.cancel'),
            destructive: true,
        });
        if (!ok) return;
        deletingRef.current = true;
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
            await readStatus();
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
            deletingRef.current = false;
            setIsDeletingModel(false);
        }
        // `store` is a stable singleton ref.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onDiskBytes, fallBackToCloud, readStatus, toast, t]);

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
        refresh,
        missingBytes,
        onDiskBytes,
        runnable,
        waitingForNative,
        modelsSizeBytes,
        textEngine,
        selectEngine,
        showEngineGroup,
        nativeAvailable: native?.available ?? false,
        nativeReasonKey,
        isDownloading,
        downloadBytes,
        failureKind,
        storageShort,
        freeUpSize,
        handleDownload,
        handleDeleteModels,
    };
}
